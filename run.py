import subprocess
import sys
import os
import threading

args = sys.argv[1:]
p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def forward_stderr():
    while True:
        data = os.read(p.stderr.fileno(), 65536)
        if not data:
            break
        sys.stderr.buffer.write(data)
        sys.stderr.buffer.flush()

t = threading.Thread(target=forward_stderr, daemon=True)
t.start()

try:
    while True:
        data = os.read(p.stdout.fileno(), 65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    p.wait()
    t.join(timeout=5)
except Exception:
    p.terminate()
finally:
    p.wait()
sys.exit(p.returncode)
