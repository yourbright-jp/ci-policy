# Bun execution boundary migration

The current security release retains patched Node 26.12.1 for trusted checker
execution. A Bun migration is a separate change and must not remove runtime
isolation or silently fall back to an unrestricted process.

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

## Proposed execution mechanism

Use a Linux OCI container on a runner with a supported container engine, with
an immutable Bun image digest, a read-only filesystem, an isolated network
namespace, no capabilities, no-new-privileges, an explicit non-root user, and
read-only bind mounts for the staged program/input trees. The image must have
the required upstream security fixes; a version number alone is insufficient.

Network namespace isolation alone still permits loopback. A reviewed seccomp
profile must deny socket creation/connection and process creation while allowing
the Bun runtime's required threads. The profile must distinguish thread creation
from process creation and fail closed if the host cannot enforce it. The initial
runtime launch and runtime initialization require an explicit, tested design;
do not claim a generic Docker invocation enforces every requirement above.

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
