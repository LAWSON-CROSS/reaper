package main

import (
	"archive/zip"
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func installDir() string {
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "Reaper")
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "Reaper")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "reaper")
}

func pause() {
	if runtime.GOOS == "windows" {
		fmt.Print("\nPress Enter to close this window...")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
}

func fail(format string, a ...any) {
	fmt.Printf("\n  PROBLEM: "+format+"\n", a...)
	pause()
	os.Exit(1)
}

func runInstaller(args []string) {
	fmt.Println()
	fmt.Println("  Reaper helper setup  (v" + version + ")")
	fmt.Println("  ------------------------------")
	for _, a := range args {
		if a == "--uninstall" || a == "/uninstall" {
			uninstall()
			return
		}
	}
	dir := installDir()
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		fail("can't create %s: %v", dir, err)
	}

	// 1. copy this program into place
	self, _ := os.Executable()
	target := filepath.Join(dir, exeName("reaper-host"))
	if !samePath(self, target) {
		if err := copyFile(self, target); err != nil {
			fail("couldn't update the helper (%v).\n  Close Firefox completely and run setup again.", err)
		}
	}
	fmt.Println("  [ok] helper installed in " + dir)

	// 2. tools
	fresh := false
	for _, a := range args {
		if a == "--fresh" {
			fresh = true // ignore copies elsewhere on the machine; used for testing
		}
	}
	missing := 0
	need := func(name string) bool {
		if _, err := os.Stat(filepath.Join(bin, exeName(name))); err == nil {
			fmt.Printf("  [ok] %s already installed\n", name)
			return false
		}
		if p := tool(name); p != "" && !fresh {
			fmt.Printf("  [ok] %s found on this computer (%s)\n", name, p)
			return false
		}
		return true
	}
	const gh = "https://github.com/"
	arm := runtime.GOARCH == "arm64"
	pick := func(x64, arm64 string) string {
		if arm {
			return arm64
		}
		return x64
	}
	switch runtime.GOOS {
	case "windows":
		if need("yt-dlp") {
			get("yt-dlp", gh+"yt-dlp/yt-dlp/releases/latest/download/"+pick("yt-dlp.exe", "yt-dlp_arm64.exe"), filepath.Join(bin, "yt-dlp.exe"))
		}
		needFf, needProbe := need("ffmpeg"), need("ffprobe")
		if needFf || needProbe {
			getZip("ffmpeg", gh+"yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-"+pick("win64", "winarm64")+"-gpl.zip", bin, "ffmpeg.exe", "ffprobe.exe")
		}
		if need("deno") {
			getZip("deno (needed by yt-dlp for YouTube)", gh+"denoland/deno/releases/latest/download/deno-"+pick("x86_64", "aarch64")+"-pc-windows-msvc.zip", bin, "deno.exe")
		}
	case "linux":
		if need("yt-dlp") {
			dst := filepath.Join(bin, "yt-dlp")
			get("yt-dlp", gh+"yt-dlp/yt-dlp/releases/latest/download/"+pick("yt-dlp_linux", "yt-dlp_linux_aarch64"), dst)
			os.Chmod(dst, 0o755)
		}
		needFf, needProbe := need("ffmpeg"), need("ffprobe")
		if needFf || needProbe {
			getTarXz("ffmpeg", gh+"yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-"+pick("linux64", "linuxarm64")+"-gpl.tar.xz", bin, "ffmpeg", "ffprobe")
		}
		if need("deno") {
			getZip("deno (needed by yt-dlp for YouTube)", gh+"denoland/deno/releases/latest/download/deno-"+pick("x86_64", "aarch64")+"-unknown-linux-gnu.zip", bin, "deno")
		}
	case "darwin":
		if need("yt-dlp") {
			dst := filepath.Join(bin, "yt-dlp")
			get("yt-dlp", gh+"yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos", dst)
			os.Chmod(dst, 0o755)
		}
		if need("deno") {
			getZip("deno (needed by yt-dlp for YouTube)", gh+"denoland/deno/releases/latest/download/deno-"+pick("x86_64", "aarch64")+"-apple-darwin.zip", bin, "deno")
		}
		needFf, needProbe := need("ffmpeg"), need("ffprobe")
		if needFf || needProbe {
			// There is no official static ffmpeg for macOS, so use Homebrew.
			if brew := tool("brew"); brew != "" {
				fmt.Println("  [..] installing ffmpeg with Homebrew (this can take a few minutes)")
				c := exec.Command(brew, "install", "ffmpeg")
				c.Stdout, c.Stderr = os.Stdout, os.Stderr
				if err := c.Run(); err != nil || tool("ffmpeg") == "" {
					missing++
					fmt.Println("  [!!] Homebrew couldn't install ffmpeg. Run:  brew install ffmpeg")
				} else {
					fmt.Println("  [ok] ffmpeg installed")
				}
			} else {
				missing++
				fmt.Println("  [!!] ffmpeg is missing. Install Homebrew from https://brew.sh then run:")
				fmt.Println("         brew install ffmpeg")
				fmt.Println("       and run this setup again.")
			}
		}
	default:
		for _, t := range []string{"yt-dlp", "ffmpeg", "ffprobe", "deno"} {
			if need(t) {
				missing++
				fmt.Printf("  [!!] %s is missing: install it with your package manager\n", t)
			}
		}
	}

	// 3. tell Firefox where the helper lives
	manifest := filepath.Join(dir, hostName+".json")
	data, _ := json.MarshalIndent(map[string]any{
		"name":               hostName,
		"description":        "Reaper download helper",
		"path":               target,
		"type":               "stdio",
		"allowed_extensions": []string{extensionID},
	}, "", "  ")
	if err := os.WriteFile(manifest, data, 0o644); err != nil {
		fail("couldn't write %s: %v", manifest, err)
	}
	switch runtime.GOOS {
	case "windows":
		out, err := exec.Command("reg", "add", `HKCU\Software\Mozilla\NativeMessagingHosts\`+hostName, "/ve", "/t", "REG_SZ", "/d", manifest, "/f").CombinedOutput()
		if err != nil {
			fail("couldn't register with Firefox: %s", strings.TrimSpace(string(out)))
		}
	default:
		home, _ := os.UserHomeDir()
		d := filepath.Join(home, ".mozilla", "native-messaging-hosts")
		if runtime.GOOS == "darwin" {
			d = filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
		}
		os.MkdirAll(d, 0o755)
		if err := os.WriteFile(filepath.Join(d, hostName+".json"), data, 0o644); err != nil {
			fail("couldn't register with Firefox: %v", err)
		}
	}
	fmt.Println("  [ok] registered with Firefox")
	fmt.Println()
	if missing > 0 {
		fmt.Println("  Almost done: fix the [!!] items above, then run setup again.")
	} else {
		fmt.Println("  All done. Open Firefox and click the scythe.")
	}
	pause()
}

func uninstall() {
	if runtime.GOOS == "windows" {
		exec.Command("reg", "delete", `HKCU\Software\Mozilla\NativeMessagingHosts\`+hostName, "/f").Run()
	} else {
		home, _ := os.UserHomeDir()
		os.Remove(filepath.Join(home, ".mozilla", "native-messaging-hosts", hostName+".json"))
		os.Remove(filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", hostName+".json"))
	}
	fmt.Println("  [ok] unregistered from Firefox")
	fmt.Println("  You can now delete the folder " + installDir())
	pause()
}

func samePath(a, b string) bool {
	ai, e1 := os.Stat(a)
	bi, e2 := os.Stat(b)
	return e1 == nil && e2 == nil && os.SameFile(ai, bi)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

type meter struct {
	label string
	total int64
	done  int64
	last  time.Time
}

func (m *meter) Write(p []byte) (int, error) {
	m.done += int64(len(p))
	if time.Since(m.last) > 200*time.Millisecond {
		m.last = time.Now()
		m.print()
	}
	return len(p), nil
}

func (m *meter) print() {
	mb := float64(m.done) / (1 << 20)
	if m.total > 0 {
		fmt.Printf("\r  [..] downloading %s  %3.0f%%  (%.0f MB)   ", m.label, float64(m.done)/float64(m.total)*100, mb)
	} else {
		fmt.Printf("\r  [..] downloading %s  %.0f MB   ", m.label, mb)
	}
}

func get(label, url, dst string) {
	resp, err := http.Get(url)
	if err != nil {
		fail("couldn't download %s: %v", label, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fail("couldn't download %s: server said %s", label, resp.Status)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		fail("couldn't write %s: %v", tmp, err)
	}
	m := &meter{label: label, total: resp.ContentLength}
	_, err = io.Copy(f, io.TeeReader(resp.Body, m))
	f.Close()
	if err != nil {
		os.Remove(tmp)
		fail("download of %s was interrupted: %v", label, err)
	}
	os.Remove(dst)
	if err := os.Rename(tmp, dst); err != nil {
		fail("couldn't save %s: %v", dst, err)
	}
	fmt.Printf("\r  [ok] %s downloaded                                        \n", label)
}

// getTarXz downloads a .tar.xz and pulls the named files out of it into dir.
// Go has no xz reader in its standard library, so this uses the system tar.
func getTarXz(label, url, dir string, want ...string) {
	tmp := filepath.Join(dir, "download.tar.xz")
	get(label, url, tmp)
	defer os.Remove(tmp)
	work, err := os.MkdirTemp(dir, "unpack-")
	if err != nil {
		fail("couldn't unpack %s: %v", label, err)
	}
	defer os.RemoveAll(work)
	if out, err := exec.Command("tar", "-xJf", tmp, "-C", work).CombinedOutput(); err != nil {
		fail("couldn't unpack %s (is xz installed?): %s", label, strings.TrimSpace(string(out)))
	}
	found := 0
	filepath.Walk(work, func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return nil
		}
		for _, w := range want {
			if fi.Name() == w {
				if copyFile(p, filepath.Join(dir, w)) == nil {
					found++
				}
			}
		}
		return nil
	})
	if found < len(want) {
		fail("the %s download didn't contain what was expected", label)
	}
}

// getZip downloads a zip and pulls the named files out of it into dir.
func getZip(label, url, dir string, want ...string) {
	tmp := filepath.Join(dir, "download.zip")
	get(label, url, tmp)
	defer os.Remove(tmp)
	zr, err := zip.OpenReader(tmp)
	if err != nil {
		fail("couldn't open the %s download: %v", label, err)
	}
	defer zr.Close()
	found := 0
	for _, f := range zr.File {
		for _, w := range want {
			if strings.EqualFold(filepath.Base(f.Name), w) && !f.FileInfo().IsDir() {
				rc, err := f.Open()
				if err != nil {
					fail("couldn't unpack %s: %v", w, err)
				}
				out, err := os.OpenFile(filepath.Join(dir, w), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
				if err == nil {
					_, err = io.Copy(out, rc)
					out.Close()
				}
				rc.Close()
				if err != nil {
					fail("couldn't unpack %s: %v", w, err)
				}
				found++
			}
		}
	}
	if found < len(want) {
		fail("the %s download didn't contain what was expected", label)
	}
}
