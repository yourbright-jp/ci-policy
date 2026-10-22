import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TRUSTED_BUN_VERSION = "1.4.3";
export const TRUSTED_BUN_IMAGE = "oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598";
const DOCKER = "/usr/bin/docker";
const environment = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", DOCKER_CONFIG: "/nonexistent", LANG: "C.UTF-8" };

const runtimeGuard = String.raw`
// Verify the kernel boundary directly. Bun's node:net can translate EPERM into
// ECONNREFUSED, so an ordinary connection failure is not sufficient evidence.
const ffi = require('bun:ffi');
const native = ffi.dlopen('libc.so.6', {
  socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
  close: { args: ['i32'], returns: 'i32' },
  fork: { args: [], returns: 'i32' },
  _exit: { args: ['i32'], returns: 'void' },
  __errno_location: { args: [], returns: 'ptr' },
});
const errno = new Int32Array(ffi.toArrayBuffer(native.symbols.__errno_location(), 0, 4));
for (const [family, type] of [[1, 1], [2, 1], [2, 2], [10, 1]]) {
  const fd = native.symbols.socket(family, type, 0);
  if (fd !== -1) { native.symbols.close(fd); throw Error('Socket syscall was not denied'); }
  if (errno[0] !== 1) throw Error('Socket syscall did not return EPERM');
}
const child = native.symbols.fork();
if (child === 0) native.symbols._exit(99);
if (child !== -1 || errno[0] !== 1) throw Error('Process creation was not denied');
native.close();

const denied = function () {
  const error = new Error('This capability is disabled in trusted checks');
  error.code = 'ERR_ACCESS_DENIED';
  throw error;
};
const lock = (object, key) => Object.defineProperty(object, key, {
  value: denied, configurable: false, writable: false,
});
for (const key of Object.keys(ffi)) {
  if (typeof ffi[key] === 'function') lock(ffi, key);
}
const workers = require('node:worker_threads');
lock(workers, 'Worker');
lock(globalThis, 'Worker');
for (const key of ['spawn', 'spawnSync', 'dlopen']) {
  if (typeof Bun[key] === 'function') lock(Bun, key);
}
`;

// An allowlist, not Docker's default profile with a few extra denials. In
// particular, sockets (including Unix/loopback), fork/vfork, io_uring, ptrace,
// mounts and namespace changes are not available to the checker.
const seccomp = {
  defaultAction: "SCMP_ACT_ERRNO",
  defaultErrnoRet: 1,
  architectures: ["SCMP_ARCH_X86_64"],
  syscalls: [
    { action: "SCMP_ACT_ALLOW", names: [
      "read", "write", "readv", "writev", "pread64", "close", "close_range",
      "fstat", "newfstatat", "statx", "stat", "lstat", "lseek", "mmap",
      "mprotect", "munmap", "mremap", "madvise", "brk", "rt_sigaction",
      "rt_sigprocmask", "rt_sigreturn", "sigaltstack", "arch_prctl",
      "set_tid_address", "set_robust_list", "rseq", "futex", "futex_waitv",
      "prlimit64", "getrlimit", "setrlimit", "getrandom", "clock_gettime",
      "clock_getres", "gettimeofday", "time", "nanosleep", "clock_nanosleep",
      "getpid", "gettid", "getppid", "getuid", "geteuid", "getgid", "getegid",
      "getresuid", "getresgid", "getgroups", "uname", "sysinfo", "sched_getaffinity",
      "sched_yield", "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait",
      "epoll_pwait2", "eventfd2", "pipe2", "fcntl", "ioctl", "poll", "ppoll",
      "pselect6", "select", "readlink", "readlinkat", "getcwd", "getdents64",
      "openat", "access", "faccessat", "faccessat2", "exit", "exit_group",
      "tgkill", "kill", "wait4", "waitid", "execve", "restart_syscall",
      "statfs", "fstatfs", "membarrier", "chdir", "prctl", "capget",
    ] },
    // glibc must fall back to clone, whose scalar flags can be filtered. Bun's
    // engine threads share the process; creating another process is refused.
    { action: "SCMP_ACT_ERRNO", errnoRet: 38, names: ["clone3"] },
    { action: "SCMP_ACT_ALLOW", names: ["clone"], args: [
      { index: 0, op: "SCMP_CMP_MASKED_EQ", value: 0x7e034000, valueTwo: 0x10000 },
    ] },
  ],
};

function docker(args: string[], timeout = 5_000) {
  return spawnSync(DOCKER, args, { encoding: "utf8", env: environment, timeout,
    killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

export function trustedSandboxAvailable(): boolean {
  if (process.platform !== "linux" || process.arch !== "x64" || process.versions.bun !== TRUSTED_BUN_VERSION) return false;
  const result = docker(["image", "inspect", TRUSTED_BUN_IMAGE, "--format={{.Id}}"]);
  return !result.error && result.status === 0 && /^sha256:[a-f0-9]{64}\s*$/.test(result.stdout);
}

function makeReadable(root: string) {
  chmodSync(root, 0o755);
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, item.name);
    if (item.isDirectory()) makeReadable(child);
    else if (item.isFile()) chmodSync(child, 0o644);
    else throw new Error("Only staged regular files may enter the sandbox");
  }
}

export function runTrustedBunSandbox(root: string, entrypoint: string, args: string[], timeoutMs = 30_000, diagnostics = false): boolean {
  if (!trustedSandboxAvailable()) return false;
  const container = `ci-policy-trusted-${randomUUID()}`;
  const profile = path.join(root, "seccomp.json");
  writeFileSync(profile, JSON.stringify(seccomp), { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(root, "runtime-guard.mjs"), runtimeGuard, { flag: "wx", mode: 0o600 });
  makeReadable(root);
  const inside = (file: string) => {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unstaged sandbox argument");
    return `/sandbox/${relative.split(path.sep).join("/")}`;
  };
  let success = false;
  try {
    const result = docker([
      "run", "--rm", "--pull=never", "--name", container,
      "--label", "ci-policy-trusted=true", "--network=none", "--read-only",
      "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      `--security-opt=seccomp=${profile}`, "--pids-limit=64", "--memory=512m",
      "--memory-swap=512m", "--cpus=1", "--ulimit=nofile=128:128", "--ipc=none",
      "--mount", `type=bind,src=${root},dst=/sandbox,readonly`,
      "--workdir=/sandbox", "--env=CI=true", "--env=HOME=/nonexistent", "--entrypoint=/usr/local/bin/bun",
      TRUSTED_BUN_IMAGE, "--no-env-file", "--no-install", "--no-addons",
      "--disallow-code-generation-from-strings=strict", "--preload=/sandbox/runtime-guard.mjs",
      inside(entrypoint), ...args.map(inside),
    ], Math.min(Math.max(timeoutMs, 100), 30_000));
    success = !result.error && !result.signal && result.status === 0;
    // Only the fixed, credential-free acceptance probes enable diagnostics.
    // Candidate checker output is never copied into policy logs.
    if (!success && diagnostics) console.error(result.error?.message ?? result.stderr.slice(0, 2000));
  } finally {
    // Killing the Docker client alone does not kill the checker. Always remove
    // its named container, and verify absence even after a client timeout.
    docker(["rm", "--force", container]);
    const remaining = docker(["ps", "--all", "--quiet", "--filter", `name=^${container}$`]);
    if (remaining.error || remaining.status !== 0 || remaining.stdout.trim()) success = false;
  }
  return success;
}
