# Bun execution boundary migration

Version 9 runs trusted checkers with Bun 1.4.3 in a digest-pinned Linux x64 OCI
image. Unsupported hosts, a missing prepared image, or a failed boundary probe
fail closed. There is no Node or unrestricted-process fallback. The legacy
`trusted_node_checks` contract key remains unchanged to preserve immutable
contract evolution and the existing caller data format.

## Required boundary

- Run only the immutable, reviewed base module closure. Candidate files remain
  declared, bounded data inputs in a separate tree.
- Strip inherited credentials and package/runtime loader configuration.
- Mount the program and input trees read-only. Do not expose the host checkout,
  home directory, Docker socket, metadata service, or runner credentials.
- Deny all network access, including loopback, DNS, UDP, and Unix sockets that
  could reach host services.
- Deny filesystem writes, child processes, native add-ons/FFI, workers, dynamic
  module loading, and string code generation. Keep the existing static module
  validation as an additional layer.
- Bound wall time, CPU, memory, output, and process/thread resources. Terminate
  and remove the sandbox even when its supervising process times out.

## Execution mechanism

Use a Linux OCI container on a runner with a supported container engine, with
an immutable Bun image digest, a read-only filesystem, an isolated network
namespace, no capabilities, no-new-privileges, an explicit non-root user, and
read-only bind mounts for the staged program/input trees. The image must have
an independently reviewed runtime and no reachable vulnerable decoder path.
Brotli remains linked in Bun, but a checker cannot create any socket, including
loopback, DNS, UDP or Unix sockets. The static module allowlist excludes zlib,
FFI and runtime loading; Bun, Worker and WebAssembly globals are also rejected.
This is an execution-path mitigation, not a claim that the library was patched.

Network namespace isolation alone still permits loopback. The seccomp allowlist
does not allow socket, connect, fork, vfork, mounts, namespace changes, ptrace or
io_uring. clone3 returns ENOSYS so glibc uses clone, which is allowed only with
CLONE_THREAD and without namespace/vfork flags. Bun's required engine threads
can initialize; another process cannot start. execve permits the initial runtime
launch but cannot create an additional process.

Before loading a checker, a fixed preload calls libc socket for Unix, IPv4, IPv6
and UDP and fork, requiring kernel EPERM. This avoids trusting Bun's translated
network errors: node:net can report ECONNREFUSED for a denied socket syscall.
After this fixed probe, all exported FFI functions, Worker constructors and Bun
spawn functions are sealed off. --no-addons blocks Node native addons; it is not
treated as an FFI switch. --disallow-code-generation-from-strings=strict rejects
string-generated code. Static module validation remains an independent layer.

Do not expose the Docker API to checker code. The trusted supervisor, outside
the sandbox, creates and destroys a uniquely named container. Resolve and verify
the image before starting untrusted-input checks, with no image pulls or package
auto-installation performed inside the sandbox.

## Acceptance gates

Before changing the production workflow, run the same probe matrix through the
actual sandbox executor: allowed staged reads and a legitimate checker must
succeed; host/outside-tree reads, writes, TCP, HTTP/fetch, DNS, UDP, subprocesses,
workers, FFI, string evaluation, and undeclared module loading must fail. Verify
credential stripping, timeout cleanup, resource limits, next-base viability,
and the existing contract evolution/module-closure regression suite.

The runner must support the isolation mechanism. Moving from a slim container
runner to a full VM is an explicit workflow change, with its own CI validation.
No security probe may be removed merely to make Bun compatibility tests pass.

The supervisor is outside the checker container. Only the staged program/input
tree is bind-mounted, read-only. The image contains public runtime files, not
host files or credentials. Containers run as UID/GID 65532 with no capabilities,
no-new-privileges, 512 MiB memory, one CPU, 64 PIDs/threads and bounded descriptors.
Output is limited to 64 KiB and is not copied into candidate-check failure logs.
The wall limit is 30 seconds. The supervisor kills a timed-out Docker client with
SIGKILL, forcibly removes its uniquely named container, then verifies absence.
Killing only the client or forwarding SIGTERM is not sufficient cleanup.
