# Kernel: Example — asynchronous CPU core

What this project refuses on purpose. Everything not listed here can be built the normal way.

## Refuses
- R1: one global clock paces every stage | tells: global clock, clock tree, /clk_?en/, synchronous pipeline | instead: each stage hands off by local request/acknowledge; timing is a property of the handshake, not a shared edge
- R2: instruction width is fixed at decode | tells: fixed-width, 32-bit instruction, /decode\s+width/ | instead: width is read from the stream; decode reports how much it consumed
- R3: a central scheduler decides issue order | tells: scheduler, issue queue, reservation station | instead: operands announce readiness and units pull work

## Keeps conventional
- build system (CMake), test harness (pytest + cocotb), waveform format (VCD), file layout
