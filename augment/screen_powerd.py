#!/usr/bin/env python3
"""
Touch-to-Wake Screen Power-Save Daemon for Raspberry Pi DSI Touchscreen (tar1090-project).

Watches /dev/input/event* (capacitive touchscreen ft5x06 / Goodix + mouse/keyboard)
using kernel select() at zero CPU overhead:
- 0s .. 90s after touch:   Full brightness (255, bl_power=0)
- 90s .. 120s after touch: Dimmed preview (40, bl_power=0)
- >120s after touch:       Backlight powered OFF (0, bl_power=4)
- Instant wake (<10ms) on any screen touch or mouse/key input.
"""

import glob
import os
import select
import signal
import sys
import time
from typing import List

DIM_TIMEOUT_S = float(os.environ.get("SCREEN_DIM_SECONDS", "90"))
OFF_TIMEOUT_S = float(os.environ.get("SCREEN_OFF_SECONDS", "120"))
FULL_BRIGHTNESS = int(os.environ.get("SCREEN_MAX_BRIGHTNESS", "255"))
DIM_BRIGHTNESS = int(os.environ.get("SCREEN_DIM_BRIGHTNESS", "38"))


def find_backlight_dir() -> str:
    candidates = sorted(glob.glob("/sys/class/backlight/*"))
    if candidates:
        return candidates[0]
    return "/sys/class/backlight/11-0045"


BACKLIGHT_DIR = find_backlight_dir()


def set_backlight(brightness: int, power_off: bool) -> None:
    try:
        bl_power_path = os.path.join(BACKLIGHT_DIR, "bl_power")
        bright_path = os.path.join(BACKLIGHT_DIR, "brightness")
        if not power_off:
            if os.path.exists(bl_power_path):
                with open(bl_power_path, "w") as f:
                    f.write("0\n")
            if os.path.exists(bright_path):
                with open(bright_path, "w") as f:
                    f.write(f"{brightness}\n")
        else:
            if os.path.exists(bright_path):
                with open(bright_path, "w") as f:
                    f.write("0\n")
            if os.path.exists(bl_power_path):
                with open(bl_power_path, "w") as f:
                    f.write("4\n")
    except Exception as exc:
        print(f"[screen_powerd] backlight write error: {exc}", flush=True)


def open_input_devices() -> List[int]:
    fds: List[int] = []
    for path in sorted(glob.glob("/dev/input/event*")):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            fds.append(fd)
        except Exception:
            pass
    return fds


def close_fds(fds: List[int]) -> None:
    for fd in fds:
        try:
            os.close(fd)
        except Exception:
            pass


def main() -> None:
    fds = open_input_devices()
    last_activity = time.monotonic()
    state = "ON"  # ON, DIM, OFF

    def handle_exit(signum, frame):
        set_backlight(FULL_BRIGHTNESS, power_off=False)
        close_fds(fds)
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_exit)
    signal.signal(signal.SIGINT, handle_exit)

    set_backlight(FULL_BRIGHTNESS, power_off=False)
    print(
        f"[screen_powerd] Monitoring {len(fds)} input devices | backlight={BACKLIGHT_DIR} | "
        f"dim={DIM_TIMEOUT_S}s off={OFF_TIMEOUT_S}s",
        flush=True,
    )

    last_rescan = time.monotonic()
    while True:
        now = time.monotonic()
        idle_s = now - last_activity

        if state == "ON":
            timeout = max(0.5, DIM_TIMEOUT_S - idle_s)
        elif state == "DIM":
            timeout = max(0.5, OFF_TIMEOUT_S - idle_s)
        else:
            timeout = 5.0

        try:
            rlist, _, _ = select.select(fds, [], [], timeout)
        except Exception:
            close_fds(fds)
            time.sleep(1.0)
            fds = open_input_devices()
            continue

        now = time.monotonic()
        if rlist:
            for fd in rlist:
                try:
                    while os.read(fd, 4096):
                        pass
                except BlockingIOError:
                    pass
                except OSError:
                    # Device disconnected; trigger rescan
                    close_fds(fds)
                    fds = open_input_devices()
                    break
            last_activity = now
            if state != "ON":
                set_backlight(FULL_BRIGHTNESS, power_off=False)
                state = "ON"
        else:
            idle_s = now - last_activity
            if idle_s >= OFF_TIMEOUT_S and state != "OFF":
                set_backlight(0, power_off=True)
                state = "OFF"
            elif DIM_TIMEOUT_S <= idle_s < OFF_TIMEOUT_S and state == "ON":
                set_backlight(DIM_BRIGHTNESS, power_off=False)
                state = "DIM"

        if now - last_rescan > 60.0:
            last_rescan = now
            if not fds:
                fds = open_input_devices()


if __name__ == "__main__":
    main()
