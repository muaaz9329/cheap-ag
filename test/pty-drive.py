"""Runs a command in a pseudo-terminal and answers its prompts, for testing interactive CLIs.

Usage: python3 pty-drive.py '<json>' where json = {"cmd": [...], "cwd": str, "env": {...},
"steps": [{"expect": regex, "send": text}], "timeout": seconds}. `expect` is matched against the screen text
squashed (no whitespace, no leftover colour codes), since TUIs like OpenCode's draw prompts a character at a time,
so write prompts without spaces, e.g. "EnteryourAPIkey". Prints the ANSI-stripped transcript,
then a final line "EXIT <code>" ("timeout" if it never exited), with " UNMATCHED <expect>" when a prompt never appeared.
"""
import json, os, pty, re, select, signal, sys, time

spec = json.loads(sys.argv[1])
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r")
SQUASH = re.compile(r"\s+|\[[0-9;]*m?")
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(spec["cwd"])
        os.execve(spec["cmd"][0], spec["cmd"], spec["env"])
    finally:
        os._exit(127)

raw, seen, steps = b"", 0, list(spec["steps"])
deadline = time.time() + spec.get("timeout", 60)
status = None
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if not chunk:  # the child closed the terminal: collect its exit status
            status = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
            break
        raw += chunk
    text = SQUASH.sub("", ANSI.sub("", raw.decode(errors="ignore")))
    if steps and re.search(steps[0]["expect"], text[seen:]):
        seen = len(text)
        os.write(fd, steps.pop(0)["send"].encode())
    done, code = os.waitpid(pid, os.WNOHANG)
    if done:
        status = os.waitstatus_to_exitcode(code)
        try:
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                raw += chunk
        except OSError:
            pass
        break
if status is None:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
print(ANSI.sub("", raw.decode(errors="ignore")))
# a prompt that never appeared is a failure in itself, whatever the exit code
print(f"EXIT {status if status is not None else 'timeout'}" + (f" UNMATCHED {steps[0]['expect']}" if steps else ""))
