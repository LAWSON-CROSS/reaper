// Reaper helper: a Firefox native-messaging host that runs yt-dlp and ffmpeg
// on behalf of the Reaper extension. Run with no arguments it installs itself.
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	hostName    = "reaper_host"
	extensionID = "reaper@localhost"
	version     = "1.1.0"
)

func main() {
	for _, a := range os.Args[1:] {
		// Firefox launches the host with the manifest path and the extension id.
		if a == extensionID || strings.HasSuffix(strings.ToLower(a), ".json") {
			runHost()
			return
		}
	}
	runInstaller(os.Args[1:])
}

// ---------- native messaging ----------

type Settings struct {
	Container  string `json:"container"`  // mp4 | mov | mkv | webm
	VCodec     string `json:"vcodec"`     // copy | h264 | h265 | prores_* | dnxhr_* | vp9 | av1
	Resolution int    `json:"resolution"` // max height, 0 = best available
	VBitrate   int    `json:"vbitrate"`   // kbps, 0 = quality-based
	ACodec     string `json:"acodec"`     // source | mp3 | aac | wav | flac | opus | alac
	ABitrate   int    `json:"abitrate"`   // kbps
	GPU        bool   `json:"gpu"`
	Cookies    bool   `json:"cookies"`
}

type Msg struct {
	Type     string   `json:"type"`
	ID       string   `json:"id,omitempty"`
	URL      string   `json:"url,omitempty"`
	Mode     string   `json:"mode,omitempty"` // audio | video | both
	OutDir   string   `json:"outDir,omitempty"`
	Path     string   `json:"path,omitempty"`
	Settings Settings `json:"settings"`
}

type M map[string]any

var outMu sync.Mutex

func send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	binary.Write(os.Stdout, binary.LittleEndian, uint32(len(b)))
	os.Stdout.Write(b)
}

func readMsg(r io.Reader) (*Msg, error) {
	var n uint32
	if err := binary.Read(r, binary.LittleEndian, &n); err != nil {
		return nil, err
	}
	if n > 8<<20 {
		return nil, errors.New("message too large")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	var m Msg
	if err := json.Unmarshal(buf, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

var (
	jobsMu sync.Mutex
	jobs   = map[string]context.CancelFunc{}
)

func runHost() {
	in := bufio.NewReader(os.Stdin)
	root, cancelAll := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for {
		m, err := readMsg(in)
		if err != nil {
			break // Firefox closed the pipe
		}
		switch m.Type {
		case "hello":
			go func() { send(helloInfo()) }()
		case "download":
			ctx, cancel := context.WithCancel(root)
			jobsMu.Lock()
			jobs[m.ID] = cancel
			jobsMu.Unlock()
			wg.Add(1)
			go func(m *Msg) {
				defer wg.Done()
				files, err := runJob(ctx, m)
				cancelled := ctx.Err() != nil
				cancel()
				jobsMu.Lock()
				delete(jobs, m.ID)
				jobsMu.Unlock()
				switch {
				case cancelled:
					send(M{"type": "cancelled", "id": m.ID})
				case err != nil:
					send(M{"type": "error", "id": m.ID, "message": err.Error()})
				default:
					send(M{"type": "done", "id": m.ID, "files": files})
				}
			}(m)
		case "cancel":
			jobsMu.Lock()
			if c, ok := jobs[m.ID]; ok {
				c()
			}
			jobsMu.Unlock()
		case "pickFolder":
			go func(start string) {
				p, err := pickFolder(start)
				if err != nil || p == "" {
					send(M{"type": "folder", "path": ""})
					return
				}
				send(M{"type": "folder", "path": p})
			}(m.Path)
		case "openFolder":
			go openFolder(m.Path)
		case "update":
			go func() {
				out, err := updateYtdlp(root)
				send(M{"type": "updateResult", "ok": err == nil, "output": out})
				send(helloInfo())
			}()
		}
	}
	cancelAll()
	wg.Wait()
}

// ---------- tools ----------

func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Dir(p)
}

func binDir() string { return filepath.Join(exeDir(), "bin") }

func exeName(n string) string {
	if runtime.GOOS == "windows" {
		return n + ".exe"
	}
	return n
}

// extraDirs are places package managers put tools that a browser launched from
// the desktop doesn't have on its PATH (Homebrew on macOS in particular).
func extraDirs() []string {
	if runtime.GOOS == "windows" {
		return nil
	}
	return []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"}
}

// tool finds a helper binary: our own bin folder first, then PATH.
func tool(name string) string {
	for _, d := range append([]string{binDir(), exeDir()}, extraDirs()...) {
		p := filepath.Join(d, exeName(name))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

func command(ctx context.Context, bin string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, bin, args...)
	hide(cmd)
	cmd.Cancel = func() error { return killTree(cmd) }
	cmd.WaitDelay = 5 * time.Second
	env := os.Environ()
	for i, e := range env {
		if strings.HasPrefix(strings.ToUpper(e), "PATH=") {
			sep := string(os.PathListSeparator)
			env[i] = e[:5] + binDir() + sep + e[5:]
			if x := extraDirs(); len(x) > 0 {
				env[i] += sep + strings.Join(x, sep)
			}
		}
	}
	cmd.Env = append(env, "PYTHONIOENCODING=utf-8", "PYTHONUTF8=1")
	return cmd
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	return s
}

func defaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, "Downloads")
}

func helloInfo() M {
	info := M{"type": "hello", "version": version, "defaultDir": defaultDir(), "os": runtime.GOOS}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if y := tool("yt-dlp"); y != "" {
		out, _ := command(ctx, y, "--version").Output()
		info["ytdlp"] = firstLine(string(out))
	}
	info["ffmpeg"] = tool("ffmpeg") != "" && tool("ffprobe") != ""
	info["deno"] = tool("deno") != ""
	return info
}

func updateYtdlp(ctx context.Context) (string, error) {
	y := tool("yt-dlp")
	if y == "" {
		return "yt-dlp is not installed. Run Reaper Setup again.", errors.New("missing")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	out, err := command(ctx, y, "-U").CombinedOutput()
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(lines[len(lines)-1]), err
}

// ---------- download pipeline ----------

type tail struct {
	mu    sync.Mutex
	lines []string
}

func (t *tail) add(s string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return
	}
	t.mu.Lock()
	t.lines = append(t.lines, s)
	if len(t.lines) > 30 {
		t.lines = t.lines[len(t.lines)-30:]
	}
	t.mu.Unlock()
}

// reason picks the most useful line to show the user.
func (t *tail) reason(fallback string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := len(t.lines) - 1; i >= 0; i-- {
		if strings.Contains(t.lines[i], "ERROR") {
			return tidy(strings.TrimPrefix(t.lines[i], "ERROR:"))
		}
	}
	if len(t.lines) > 0 {
		return tidy(t.lines[len(t.lines)-1])
	}
	return fallback
}

func tidy(s string) string {
	if i := strings.Index(s, "; please report"); i > 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 300 {
		s = string(r[:300]) + "…"
	}
	return s
}

func progress(id, stage string, pct float64, detail string) {
	if pct > 100 {
		pct = 100
	}
	send(M{"type": "progress", "id": id, "stage": stage, "percent": pct, "detail": detail})
}

// scanLines splits on \n and \r so carriage-return progress output still streams.
func scanLines(r io.Reader, fn func(string)) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		for i, b := range data {
			if b == '\n' || b == '\r' {
				return i + 1, data[:i], nil
			}
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for sc.Scan() {
		fn(sc.Text())
	}
}

func runJob(ctx context.Context, m *Msg) ([]string, error) {
	ytdlp := tool("yt-dlp")
	if ytdlp == "" {
		return nil, errors.New("yt-dlp was not found. Run Reaper Setup again.")
	}
	if tool("ffmpeg") == "" || tool("ffprobe") == "" {
		return nil, errors.New("ffmpeg was not found. Run Reaper Setup again.")
	}
	if !strings.HasPrefix(m.URL, "https://") && !strings.HasPrefix(m.URL, "http://") {
		return nil, errors.New("not a web address")
	}
	out := m.OutDir
	if out == "" {
		out = defaultDir()
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return nil, fmt.Errorf("can't use download folder: %v", err)
	}
	switch m.Mode {
	case "audio":
		return audioJob(ctx, ytdlp, m, out)
	case "video", "both":
		return videoJob(ctx, ytdlp, m, out)
	}
	return nil, errors.New("unknown download type")
}

const nameTemplate = "%(title).150B [%(id)s].%(ext)s"

func ytBase(m *Msg) []string {
	a := []string{
		"--no-playlist", "--newline", "--no-simulate", "--progress", "--encoding", "utf-8",
		"--no-mtime", "--retries", "5", "--fragment-retries", "5", "--concurrent-fragments", "4",
		"--progress-template", "download:REAPER_DL|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
	}
	if ff := tool("ffmpeg"); ff != "" {
		a = append(a, "--ffmpeg-location", filepath.Dir(ff))
	}
	if m.Settings.Cookies {
		a = append(a, "--cookies-from-browser", "firefox")
	}
	return a
}

// runYtdlp streams progress and returns any lines printed with the REAPER_FILE marker.
func runYtdlp(ctx context.Context, bin string, m *Msg, args []string) ([]string, error) {
	cmd := command(ctx, bin, args...)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var files []string
	var t tail
	var wg sync.WaitGroup
	part := 0
	last := -1.0
	handle := func(line string) {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "REAPER_DL|"):
			f := strings.Split(line, "|")
			if len(f) < 4 {
				return
			}
			pct, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(f[1]), "%")), 64)
			if err != nil {
				return
			}
			if pct < last-20 {
				part++ // a second stream (audio after video) started
			}
			last = pct
			detail := strings.TrimSpace(f[2])
			if eta := strings.TrimSpace(f[3]); eta != "" && eta != "Unknown" && eta != "NA" {
				detail += " · " + eta + " left"
			}
			stage := "Downloading"
			if part > 0 {
				stage = "Downloading audio"
			}
			progress(m.ID, stage, pct, detail)
		case strings.HasPrefix(line, "REAPER_FILE|"):
			files = append(files, strings.TrimPrefix(line, "REAPER_FILE|"))
		default:
			t.add(line)
		}
	}
	var mu sync.Mutex
	for _, r := range []io.Reader{stdout, stderr} {
		wg.Add(1)
		go func(r io.Reader) {
			defer wg.Done()
			scanLines(r, func(s string) { mu.Lock(); handle(s); mu.Unlock() })
		}(r)
	}
	wg.Wait()
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New(t.reason("yt-dlp failed"))
	}
	return files, nil
}

func audioJob(ctx context.Context, ytdlp string, m *Msg, out string) ([]string, error) {
	s := m.Settings
	args := append(ytBase(m), "-f", "ba/b", "-x", "--embed-metadata")
	formats := map[string]string{"mp3": "mp3", "aac": "m4a", "wav": "wav", "flac": "flac", "opus": "opus", "alac": "alac"}
	if f, ok := formats[s.ACodec]; ok {
		args = append(args, "--audio-format", f)
		if s.ABitrate > 0 && (s.ACodec == "mp3" || s.ACodec == "aac" || s.ACodec == "opus") {
			args = append(args, "--audio-quality", fmt.Sprintf("%dK", s.ABitrate))
		}
	}
	// Work in a private temp folder so parallel jobs never trip over each other.
	tmp, err := os.MkdirTemp(out, ".reaper-tmp-")
	if err != nil {
		return nil, fmt.Errorf("can't write to download folder: %v", err)
	}
	defer os.RemoveAll(tmp)
	args = append(args, "-P", tmp, "-o", nameTemplate, "--print", "after_move:REAPER_FILE|%(filepath)s", m.URL)
	progress(m.ID, "Starting", 0, "")
	files, err := runYtdlp(ctx, ytdlp, m, args)
	if err != nil {
		return nil, err
	}
	var final []string
	for _, f := range files {
		name := filepath.Base(f)
		ext := filepath.Ext(name)
		dst := uniquePath(out, strings.TrimSuffix(name, ext), strings.TrimPrefix(ext, "."))
		if err := os.Rename(f, dst); err != nil {
			os.Remove(dst)
			return nil, fmt.Errorf("couldn't save the file: %v", err)
		}
		final = append(final, dst)
	}
	if len(final) == 0 {
		return nil, errors.New("download finished but no file was produced")
	}
	return final, nil
}

type probeInfo struct {
	VCodec, ACodec string
	Height         int
	Duration       float64
}

func probe(ctx context.Context, file string) probeInfo {
	var p probeInfo
	outb, err := command(ctx, tool("ffprobe"), "-v", "error", "-print_format", "json", "-show_streams", "-show_format", file).Output()
	if err != nil {
		return p
	}
	var j struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if json.Unmarshal(outb, &j) != nil {
		return p
	}
	for _, s := range j.Streams {
		if s.CodecType == "video" && p.VCodec == "" {
			p.VCodec, p.Height = s.CodecName, s.Height
		}
		if s.CodecType == "audio" && p.ACodec == "" {
			p.ACodec = s.CodecName
		}
	}
	p.Duration, _ = strconv.ParseFloat(j.Format.Duration, 64)
	return p
}

// what ffprobe calls the codec each setting produces
var probeName = map[string]string{"h264": "h264", "h265": "hevc", "vp9": "vp9", "av1": "av1"}

type encoder struct {
	label string
	args  []string
}

func rateArgs(kbps int, quality ...string) []string {
	if kbps > 0 {
		k := strconv.Itoa(kbps) + "k"
		return []string{"-b:v", k, "-maxrate", strconv.Itoa(kbps*3/2) + "k", "-bufsize", strconv.Itoa(kbps*2) + "k"}
	}
	return quality
}

// videoEncoders lists encoders to try in order (GPU first when enabled).
func videoEncoders(s Settings) []encoder {
	var e []encoder
	add := func(label string, a ...string) { e = append(e, encoder{label, a}) }
	b := s.VBitrate
	switch s.VCodec {
	case "h264":
		if s.GPU {
			add("H.264 (NVIDIA)", append([]string{"-c:v", "h264_nvenc", "-preset", "p5", "-pix_fmt", "yuv420p"}, rateArgs(b, "-rc", "vbr", "-cq", "19", "-b:v", "0")...)...)
			add("H.264 (Intel)", append([]string{"-c:v", "h264_qsv", "-pix_fmt", "nv12"}, rateArgs(b, "-global_quality", "20")...)...)
			add("H.264 (AMD)", append([]string{"-c:v", "h264_amf", "-pix_fmt", "yuv420p"}, rateArgs(b, "-rc", "cqp", "-qp_i", "19", "-qp_p", "21")...)...)
		}
		add("H.264", append([]string{"-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p"}, rateArgs(b, "-crf", "18")...)...)
	case "h265":
		if s.GPU {
			add("H.265 (NVIDIA)", append([]string{"-c:v", "hevc_nvenc", "-preset", "p5", "-tag:v", "hvc1"}, rateArgs(b, "-rc", "vbr", "-cq", "22", "-b:v", "0")...)...)
			add("H.265 (Intel)", append([]string{"-c:v", "hevc_qsv", "-tag:v", "hvc1"}, rateArgs(b, "-global_quality", "22")...)...)
			add("H.265 (AMD)", append([]string{"-c:v", "hevc_amf", "-tag:v", "hvc1"}, rateArgs(b, "-rc", "cqp", "-qp_i", "21", "-qp_p", "23")...)...)
		}
		add("H.265", append([]string{"-c:v", "libx265", "-preset", "medium", "-tag:v", "hvc1"}, rateArgs(b, "-crf", "20")...)...)
	case "prores_proxy", "prores_lt", "prores_422", "prores_hq":
		prof := map[string]string{"prores_proxy": "0", "prores_lt": "1", "prores_422": "2", "prores_hq": "3"}[s.VCodec]
		add("ProRes", "-c:v", "prores_ks", "-profile:v", prof, "-vendor", "apl0", "-pix_fmt", "yuv422p10le")
	case "dnxhr_sq", "dnxhr_hq":
		add("DNxHR", "-c:v", "dnxhd", "-profile:v", s.VCodec, "-pix_fmt", "yuv422p")
	case "vp9":
		if b > 0 {
			add("VP9", "-c:v", "libvpx-vp9", "-row-mt", "1", "-b:v", strconv.Itoa(b)+"k")
		} else {
			add("VP9", "-c:v", "libvpx-vp9", "-row-mt", "1", "-crf", "31", "-b:v", "0")
		}
	case "av1":
		if b > 0 {
			add("AV1", "-c:v", "libsvtav1", "-preset", "6", "-b:v", strconv.Itoa(b)+"k")
		} else {
			add("AV1", "-c:v", "libsvtav1", "-preset", "6", "-crf", "30")
		}
	}
	return e
}

// audioArgs picks the audio track settings for a video file, falling back to
// something the container can actually hold.
func audioArgs(s Settings, src string) []string {
	want := s.ACodec
	ok := map[string][]string{
		"mp4":  {"aac", "mp3", "alac", "opus"},
		"mov":  {"aac", "mp3", "alac", "wav"},
		"mkv":  {"aac", "mp3", "alac", "opus", "flac", "wav"},
		"webm": {"opus"},
	}[s.Container]
	has := func(c string) bool {
		for _, o := range ok {
			if o == c {
				return true
			}
		}
		return false
	}
	srcName := map[string]string{"aac": "aac", "mp3": "mp3", "opus": "opus", "alac": "alac", "flac": "flac"}[src]
	if want == "source" {
		if s.Container == "mkv" || (srcName != "" && has(srcName)) {
			return []string{"-c:a", "copy"}
		}
		want = ""
	}
	if !has(want) {
		want = ok[0]
	}
	if want == srcName && (want == "aac" || want == "mp3" || want == "opus") {
		return []string{"-c:a", "copy"} // already in the right codec: don't lose a generation
	}
	br := s.ABitrate
	if br <= 0 {
		br = 256
	}
	k := strconv.Itoa(br) + "k"
	switch want {
	case "mp3":
		return []string{"-c:a", "libmp3lame", "-b:a", k}
	case "opus":
		return []string{"-c:a", "libopus", "-b:a", k}
	case "alac":
		return []string{"-c:a", "alac"}
	case "flac":
		return []string{"-c:a", "flac"}
	case "wav":
		return []string{"-c:a", "pcm_s16le"}
	}
	return []string{"-c:a", "aac", "-b:a", k}
}

var nameMu sync.Mutex

// uniquePath reserves a free file name (creating an empty placeholder) so
// parallel jobs for the same title can't pick the same one.
func uniquePath(dir, base, ext string) string {
	nameMu.Lock()
	defer nameMu.Unlock()
	p := filepath.Join(dir, base+"."+ext)
	for i := 2; i < 1000; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			f.Close()
			return p
		}
		if !os.IsExist(err) {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d).%s", base, i, ext))
	}
	return p
}

func videoJob(ctx context.Context, ytdlp string, m *Msg, out string) ([]string, error) {
	s := m.Settings
	if s.Container == "" {
		s.Container = "mp4"
	}
	if s.VCodec == "" {
		s.VCodec = "copy"
	}
	tmp, err := os.MkdirTemp(out, ".reaper-tmp-")
	if err != nil {
		return nil, fmt.Errorf("can't write to download folder: %v", err)
	}
	defer os.RemoveAll(tmp)

	// Ask for the stream closest to what we want so re-encoding is often avoidable.
	var sorts []string
	if s.Resolution > 0 {
		sorts = append(sorts, fmt.Sprintf("res:%d", s.Resolution))
	}
	prefer := map[string]string{"h264": "h264", "h265": "h265", "vp9": "vp9", "av1": "av01"}[s.VCodec]
	if prefer == "" && s.VCodec == "copy" && s.Container == "mp4" && s.Resolution > 0 && s.Resolution <= 1080 {
		prefer = "h264"
	}
	if prefer != "" {
		sorts = append(sorts, "vcodec:"+prefer)
	}
	args := ytBase(m)
	if m.Mode == "video" {
		args = append(args, "-f", "bv*/b")
	} else {
		args = append(args, "-f", "bv*+ba/b")
		if s.ACodec == "aac" || (s.Container == "mp4" || s.Container == "mov") && s.ACodec == "source" {
			sorts = append(sorts, "acodec:aac")
		}
	}
	if len(sorts) > 0 {
		args = append(args, "-S", strings.Join(sorts, ","))
	}
	args = append(args, "--merge-output-format", "mkv", "-P", tmp, "-o", nameTemplate, m.URL)
	progress(m.ID, "Starting", 0, "")
	if _, err := runYtdlp(ctx, ytdlp, m, args); err != nil {
		return nil, err
	}

	// find what yt-dlp produced
	ents, _ := os.ReadDir(tmp)
	type cand struct {
		name string
		size int64
	}
	var cs []cand
	for _, e := range ents {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".part") || strings.HasSuffix(e.Name(), ".ytdl") {
			continue
		}
		if fi, err := e.Info(); err == nil {
			cs = append(cs, cand{e.Name(), fi.Size()})
		}
	}
	if len(cs) == 0 {
		return nil, errors.New("download finished but no file was produced")
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].size > cs[j].size })
	src := filepath.Join(tmp, cs[0].name)
	base := strings.TrimSuffix(cs[0].name, filepath.Ext(cs[0].name))

	info := probe(ctx, src)
	if info.VCodec == "" {
		return nil, errors.New("this link has no video stream (try Audio)")
	}

	common := []string{"-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-i", src, "-map", "0:v:0"}
	var aud []string
	if m.Mode == "both" && info.ACodec != "" {
		common = append(common, "-map", "0:a:0")
		aud = audioArgs(s, info.ACodec)
	} else {
		aud = []string{"-an"}
	}
	var tailArgs []string
	tailArgs = append(tailArgs, aud...)
	tailArgs = append(tailArgs, "-map_metadata", "0")
	if s.Container == "mp4" || s.Container == "mov" {
		tailArgs = append(tailArgs, "-movflags", "+faststart")
	}
	if m.Mode == "video" {
		base += " (no audio)"
	}
	dst := uniquePath(out, base, s.Container)
	tailArgs = append(tailArgs, dst)

	needScale := s.Resolution > 0 && info.Height > s.Resolution
	copyVideo := s.VCodec == "copy" || (probeName[s.VCodec] == info.VCodec && s.VBitrate == 0 && !needScale)

	var attempts []encoder
	if copyVideo {
		attempts = []encoder{{"Finishing", []string{"-c:v", "copy"}}}
	} else {
		for _, e := range videoEncoders(s) {
			a := e.args
			if needScale {
				a = append([]string{"-vf", fmt.Sprintf("scale=-2:%d", s.Resolution)}, a...)
			}
			attempts = append(attempts, encoder{"Converting to " + e.label, a})
		}
		if len(attempts) == 0 {
			os.Remove(dst)
			return nil, fmt.Errorf("unknown video codec %q", s.VCodec)
		}
	}
	var lastErr error
	for _, e := range attempts {
		a := append(append(append([]string{}, common...), e.args...), tailArgs...)
		lastErr = runFfmpeg(ctx, m.ID, e.label, info.Duration, a)
		if lastErr == nil {
			return []string{dst}, nil
		}
		os.Remove(dst)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	os.Remove(dst)
	if copyVideo {
		return nil, fmt.Errorf("%s video can't go in a .%s file as-is — pick MKV or a re-encode preset (%v)", info.VCodec, s.Container, lastErr)
	}
	return nil, lastErr
}

func runFfmpeg(ctx context.Context, id, stage string, duration float64, args []string) error {
	cmd := command(ctx, tool("ffmpeg"), args...)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	var t tail
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); scanLines(stderr, t.add) }()
	go func() {
		defer wg.Done()
		pct, speed := 0.0, ""
		lastSent := time.Time{}
		scanLines(stdout, func(line string) {
			k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
			if !ok {
				return
			}
			switch k {
			case "out_time_us", "out_time_ms": // both are microseconds
				if us, err := strconv.ParseFloat(v, 64); err == nil && duration > 0 && k == "out_time_us" {
					pct = us / 1e6 / duration * 100
				}
			case "speed":
				speed = strings.TrimSpace(v)
			case "progress":
				if time.Since(lastSent) > 300*time.Millisecond || v == "end" {
					lastSent = time.Now()
					d := ""
					if speed != "" && speed != "N/A" {
						d = speed + " speed"
					}
					progress(id, stage, pct, d)
				}
			}
		})
	}()
	progress(id, stage, 0, "")
	wg.Wait()
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New(t.reason("ffmpeg failed"))
	}
	return nil
}

// ---------- folders ----------

func pickFolder(start string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		script := `Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; Opacity=0}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose where Reaper saves downloads'
$d.ShowNewFolderButton = $true
if ($env:REAPER_START -and (Test-Path $env:REAPER_START)) { $d.SelectedPath = $env:REAPER_START }
$owner.Show(); $owner.Activate()
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
$owner.Close()`
		cmd = command(ctx, "powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script)
	case "darwin":
		cmd = command(ctx, "osascript", "-e", `POSIX path of (choose folder with prompt "Choose where Reaper saves downloads")`)
	default:
		if _, err := exec.LookPath("zenity"); err == nil {
			cmd = command(ctx, "zenity", "--file-selection", "--directory", "--title=Choose where Reaper saves downloads")
		} else {
			cmd = command(ctx, "kdialog", "--getexistingdirectory", start, "--title", "Choose where Reaper saves downloads")
		}
	}
	cmd.Env = append(cmd.Env, "REAPER_START="+start)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func openFolder(p string) {
	if p == "" {
		p = defaultDir()
	}
	if st, err := os.Stat(p); err != nil || !st.IsDir() {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", p)
	case "darwin":
		cmd = exec.Command("open", p)
	default:
		cmd = exec.Command("xdg-open", p)
	}
	cmd.Start()
}
