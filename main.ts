// Tiny stack VM for make.fun's tiny-stack ISA v1: a fast, exact interpreter.
// Semantics follow ISA.md, with vm.mjs as the tie-breaker: 32-bit wrapping ints,
// 256-value data stack, 64-deep call stack, 256 words of memory, 1,000,000 steps,
// 65,536 output bytes, and every trap keeping the output written before it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function run(p, inp) {
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let sp = 0, csp = 0, olen = 0, inPos = 0, pc = 0, steps = 0;
  const n = p.length;
  for (;;) {
    if (steps === 1000000) return { out: out.subarray(0, olen), code: 10 };
    if (pc < 0 || pc >= n) return { out: out.subarray(0, olen), code: 9 };
    const op = p[pc];
    // Valid opcode ranges; anything else traps 5, before any immediate check.
    if (!((op <= 7) || (op >= 16 && op <= 34) || (op >= 48 && op <= 52) || op === 64 || op === 65 || (op >= 80 && op <= 83)))
      return { out: out.subarray(0, olen), code: 5 };
    const imm = op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
    if (pc + imm >= n) return { out: out.subarray(0, olen), code: 9 };
    steps++;
    const next = pc + 1 + imm;
    pc = next;
    switch (op) {
      case 0: return { out: out.subarray(0, olen), code: 0 }; // HALT
      case 1: // PUSH8, sign-extended
        if (sp === 256) return { out: out.subarray(0, olen), code: 3 };
        D[sp++] = (p[next - 1] << 24) >> 24; break;
      case 2: // PUSH32, little-endian
        if (sp === 256) return { out: out.subarray(0, olen), code: 3 };
        D[sp++] = p[next - 4] | (p[next - 3] << 8) | (p[next - 2] << 16) | (p[next - 1] << 24); break;
      case 3: // POP
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        sp--; break;
      case 4: // DUP
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        if (sp === 256) return { out: out.subarray(0, olen), code: 3 };
        D[sp] = D[sp - 1]; sp++; break;
      case 5: { // SWAP
        if (sp < 2) return { out: out.subarray(0, olen), code: 2 };
        const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break;
      }
      case 6: // OVER
        if (sp < 2) return { out: out.subarray(0, olen), code: 2 };
        if (sp === 256) return { out: out.subarray(0, olen), code: 3 };
        D[sp] = D[sp - 2]; sp++; break;
      case 7: { // ROT ( a b c -- b c a )
        if (sp < 3) return { out: out.subarray(0, olen), code: 2 };
        const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break;
      }
      case 23: // NEG
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        D[sp - 1] = -D[sp - 1] | 0; break;
      case 27: // NOT
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        D[sp - 1] = ~D[sp - 1]; break;
      case 48: // JMP
        pc = next + (((p[next - 2] | (p[next - 1] << 8)) << 16) >> 16); break;
      case 49: case 50: { // JZ / JNZ
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        const v = D[--sp];
        const take = op === 49 ? v === 0 : v !== 0;
        if (take) pc = next + (((p[next - 2] | (p[next - 1] << 8)) << 16) >> 16);
        break;
      }
      case 51: // CALL, target is an unsigned absolute address
        if (csp === 64) return { out: out.subarray(0, olen), code: 7 };
        C[csp++] = next; pc = p[next - 2] | (p[next - 1] << 8); break;
      case 52: // RET
        if (csp === 0) return { out: out.subarray(0, olen), code: 8 };
        pc = C[--csp]; break;
      case 64: { // LOAD
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        const a = D[sp - 1];
        if (a < 0 || a > 255) return { out: out.subarray(0, olen), code: 6 };
        D[sp - 1] = M[a]; break;
      }
      case 65: { // STORE ( v addr -- )
        if (sp < 2) return { out: out.subarray(0, olen), code: 2 };
        const a = D[sp - 1];
        if (a < 0 || a > 255) return { out: out.subarray(0, olen), code: 6 };
        M[a] = D[sp - 2]; sp -= 2; break;
      }
      case 80: { // PRINT, decimal ASCII
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        const s = String(D[--sp]);
        if (olen + s.length > 65536) return { out: out.subarray(0, olen), code: 11 };
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        break;
      }
      case 81: // PUTC
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        if (olen === 65536) return { out: out.subarray(0, olen), code: 11 };
        out[olen++] = D[--sp] & 255; break;
      case 82: // IN, -1 forever once the input is used up
        if (sp === 256) return { out: out.subarray(0, olen), code: 3 };
        D[sp++] = inPos < inp.length ? inp[inPos++] : -1; break;
      case 83: // EXIT, low byte only
        if (sp < 1) return { out: out.subarray(0, olen), code: 2 };
        return { out: out.subarray(0, olen), code: D[--sp] & 255 };
      default: { // binary operators, 0x10..0x22 except NEG/NOT handled above
        if (sp < 2) return { out: out.subarray(0, olen), code: 2 };
        const b = D[sp - 1], a = D[sp - 2];
        let r;
        switch (op) {
          case 16: r = (a + b) | 0; break;
          case 17: r = (a - b) | 0; break;
          case 18: r = Math.imul(a, b); break;
          case 19:
            if (b === 0) return { out: out.subarray(0, olen), code: 4 };
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0; break;
          case 20:
            if (b === 0) return { out: out.subarray(0, olen), code: 4 };
            r = b === -1 ? 0 : a % b | 0; break;
          case 21:
            if (b === 0) return { out: out.subarray(0, olen), code: 4 };
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0; break;
          case 22:
            if (b === 0) return { out: out.subarray(0, olen), code: 4 };
            r = (a >>> 0) % (b >>> 0) | 0; break;
          case 24: r = a & b; break;
          case 25: r = a | b; break;
          case 26: r = a ^ b; break;
          case 28: r = a << (b & 31); break;
          case 29: r = a >> (b & 31); break;
          case 30: r = (a >>> (b & 31)) | 0; break;
          case 32: r = a === b ? 1 : 0; break;
          case 33: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // 34 LTU
        }
        sp -= 2; D[sp++] = r; break;
      }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
