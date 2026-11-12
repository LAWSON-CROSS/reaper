//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

// hide keeps console windows from flashing up for every child process.
func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// killTree stops a process and everything it spawned (yt-dlp starts ffmpeg).
func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	k := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	hide(k)
	if err := k.Run(); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
