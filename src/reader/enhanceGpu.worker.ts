/**
 * 画面增强 Worker（WebGL2）
 *
 * 与 enhance.worker.ts 做同一件事：解码 → Lanczos3 重采样到显示尺寸 → 非锐化 → 输出图。
 * 区别只在算的地方：这里是 GPU 五趟全屏 pass，实测 1440×2792 一页 3~5ms，CPU 版同页
 * 330~520ms。参数和顺序必须与 enhanceCore.ts 完全一致，否则两条路会给出两张不同的图
 * （scripts/probe-enhance-gpu.mjs 的 55dB 对齐就是钉这个的）。
 *
 * 输出 JPEG q0.98，不是 PNG：实测同一页（1440×2792，页面实测图）PNG 编码 69–80ms / 3.5MB，
 * JPEG q0.98 只要 23–26ms / 0.88MB，对原图 47.4dB，解码后线条锐度 54.9 vs 55.2（差 0.5%）；
 * 2× 最近邻放大看不出振铃。PNG 的唯一好处是无损，而这里的时间和磁盘（500 张桶）都更值钱。
 * 现有的 <img>、磁盘缓存、失败退回原图、换章取消全都按 blob 的契约写的，不用改。
 */
import { targetHeight } from './enhanceCore';
import type { EnhanceRequest, EnhanceResponse } from './enhance.worker';

type Slot = {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
};

const VS = `#version 300 es
layout(location = 0) in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

/** 可分离 Lanczos3：一趟只处理一个轴，另一轴照抄 */
const lanczosFrag = (horizontal: boolean) => `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_srcN;
uniform float u_dstN;
out vec4 outColor;
float lanczos(float x, float a) {
  if (x == 0.0) return 1.0;
  if (abs(x) >= a) return 0.0;
  float px = 3.141592653589793 * x;
  return (a * sin(px / a) / px) * (sin(px) / px);
}
void main() {
  float outN = ${horizontal ? 'gl_FragCoord.x' : 'gl_FragCoord.y'};
  float other = ${horizontal ? 'gl_FragCoord.y' : 'gl_FragCoord.x'};
  float center = outN * u_srcN / u_dstN - 0.5;
  float base = floor(center - 2.0);
  vec4 acc = vec4(0.0);
  float sum = 0.0;
  for (int i = 0; i < 6; i++) {
    float s = base + float(i);
    float w = lanczos(center - s, 3.0);
    ivec2 p = ${horizontal ? 'ivec2(clamp(int(s), 0, int(u_srcN) - 1), int(other))' : 'ivec2(int(other), clamp(int(s), 0, int(u_srcN) - 1))'};
    acc += texelFetch(u_tex, p, 0) * w;
    sum += w;
  }
  outColor = acc / sum;
}`;

/** 与 enhanceCore 的 gauss(1.1) 同一组归一化权重（半径 2） */
const blurFrag = (horizontal: boolean) => `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_size;
out vec4 outColor;
const float K[5] = float[5](0.0708, 0.2444, 0.3696, 0.2444, 0.0708);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 5; i++) {
    ivec2 q = p;
    ${horizontal ? 'q.x = clamp(p.x + i - 2, 0, int(u_size.x) - 1);' : 'q.y = clamp(p.y + i - 2, 0, int(u_size.y) - 1);'}
    acc += texelFetch(u_tex, q, 0) * K[i];
  }
  outColor = acc;
}`;

/** 非锐化：原图 + 0.6 ×（原图 − 模糊），差值小于 2/255 的地方不补 */
const USM_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_blur;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  vec4 b = texelFetch(u_blur, p, 0);
  vec3 d = c.rgb - b.rgb;
  vec3 sharp = c.rgb + 0.6 * mix(vec3(0.0), d, step(vec3(0.007843), abs(d)));
  outColor = vec4(clamp(sharp, 0.0, 1.0), 1.0);
}`;

let gl: WebGL2RenderingContext | null = null;
let broken = false;
const programs: Record<string, WebGLProgram> = {};
const slots: Record<'mid' | 'out' | 'blur1' | 'blur2' | 'final', Slot | null> = {
  mid: null,
  out: null,
  blur1: null,
  blur2: null,
  final: null,
};
let srcTex: WebGLTexture | null = null;
let srcW = 0;
let srcH = 0;
let out2d: OffscreenCanvas | null = null;
let outCtx: OffscreenCanvasRenderingContext2D | null = null;
let readBuf: Uint8ClampedArray | null = null;

function compile(type: number, source: string) {
  const s = gl!.createShader(type)!;
  gl!.shaderSource(s, source);
  gl!.compileShader(s);
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) || 'shader');
  return s;
}

function program(frag: string) {
  const p = gl!.createProgram()!;
  gl!.attachShader(p, compile(gl!.VERTEX_SHADER, VS));
  gl!.attachShader(p, compile(gl!.FRAGMENT_SHADER, frag));
  gl!.linkProgram(p);
  if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p) || 'link');
  return p;
}

function init() {
  if (gl || broken) return;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('no webgl2');
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    programs.lanczosH = program(lanczosFrag(true));
    programs.lanczosV = program(lanczosFrag(false));
    programs.blurH = program(blurFrag(true));
    programs.blurV = program(blurFrag(false));
    programs.usm = program(USM_FRAG);
  } catch (e) {
    /* 没有 WebGL2、shader 编译失败都算"这条路不能用"，让主线程降级到 CPU */
    broken = true;
    throw e;
  }
}

function makeSlot(w: number, h: number): Slot {
  const tex = gl!.createTexture()!;
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
  gl!.texStorage2D(gl!.TEXTURE_2D, 1, gl!.RGBA8, w, h);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  const fbo = gl!.createFramebuffer()!;
  gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
  gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0);
  if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) throw new Error('fbo incomplete');
  return { tex, fbo, w, h };
}

function ensure(name: keyof typeof slots, w: number, h: number): Slot {
  const capH = Math.ceil(h / 256) * 256;
  const cur = slots[name];
  if (cur && cur.w === w && cur.h >= capH) return cur;
  if (cur) {
    gl!.deleteFramebuffer(cur.fbo);
    gl!.deleteTexture(cur.tex);
  }
  return (slots[name] = makeSlot(w, capH));
}

function draw(
  prog: WebGLProgram,
  slot: Slot,
  tex: WebGLTexture,
  uniforms: Record<string, number | [number, number]>,
  w: number,
  h: number,
) {
  gl!.bindFramebuffer(gl!.FRAMEBUFFER, slot.fbo);
  gl!.viewport(0, 0, w, h);
  gl!.useProgram(prog);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
  gl!.uniform1i(gl!.getUniformLocation(prog, 'u_tex'), 0);
  for (const [name, value] of Object.entries(uniforms)) {
    const loc = gl!.getUniformLocation(prog, name);
    if (typeof value === 'number') gl!.uniform1f(loc, value);
    else gl!.uniform2f(loc, value[0], value[1]);
  }
  gl!.drawArrays(gl!.TRIANGLES, 0, 3);
}

async function render(buf: ArrayBuffer, targetW: number) {
  init();
  const bm = await createImageBitmap(new Blob([buf]));
  if (bm.width >= targetW) {
    bm.close();
    return { skip: 'no-upscale' as const };
  }
  const sw = bm.width;
  const sh = bm.height;
  const th = targetHeight(sw, sh, targetW);

  if (!srcTex || srcW !== sw || srcH !== sh) {
    if (srcTex) gl!.deleteTexture(srcTex);
    srcTex = gl!.createTexture();
    gl!.bindTexture(gl!.TEXTURE_2D, srcTex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    srcW = sw;
    srcH = sh;
  }
  gl!.bindTexture(gl!.TEXTURE_2D, srcTex);
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, bm);
  bm.close();

  const mid = ensure('mid', targetW, sh);
  const out = ensure('out', targetW, th);
  const blur1 = ensure('blur1', targetW, th);
  const blur2 = ensure('blur2', targetW, th);
  const final = ensure('final', targetW, th);

  draw(programs.lanczosH, mid, srcTex, { u_srcN: sw, u_dstN: targetW }, targetW, sh);
  draw(programs.lanczosV, out, mid.tex, { u_srcN: sh, u_dstN: th }, targetW, th);
  draw(programs.blurH, blur1, out.tex, { u_size: [targetW, th] }, targetW, th);
  draw(programs.blurV, blur2, blur1.tex, { u_size: [targetW, th] }, targetW, th);

  gl!.bindFramebuffer(gl!.FRAMEBUFFER, final.fbo);
  gl!.viewport(0, 0, targetW, th);
  gl!.useProgram(programs.usm);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, out.tex);
  gl!.uniform1i(gl!.getUniformLocation(programs.usm, 'u_src'), 0);
  gl!.activeTexture(gl!.TEXTURE1);
  gl!.bindTexture(gl!.TEXTURE_2D, blur2.tex);
  gl!.uniform1i(gl!.getUniformLocation(programs.usm, 'u_blur'), 1);
  gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  gl!.activeTexture(gl!.TEXTURE0);

  if (!out2d || out2d.width !== targetW || out2d.height !== th) {
    out2d = new OffscreenCanvas(targetW, th);
    outCtx = out2d.getContext('2d', { willReadFrequently: true });
  }
  if (!outCtx) throw new Error('no 2d context');
  const need = targetW * th * 4;
  if (!readBuf || readBuf.length < need) readBuf = new Uint8ClampedArray(need);
  const pixels = readBuf.subarray(0, need);
  gl!.bindFramebuffer(gl!.FRAMEBUFFER, final.fbo);
  gl!.readPixels(0, 0, targetW, th, gl!.RGBA, gl!.UNSIGNED_BYTE, pixels);
  gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
  const frame = outCtx.createImageData(targetW, th);
  frame.data.set(pixels);
  outCtx.putImageData(frame, 0, 0);

  const blob = await out2d.convertToBlob({ type: 'image/jpeg', quality: 0.98 });
  return { blob, from: [sw, sh] as [number, number], to: [targetW, th] as [number, number] };
}

self.onmessage = async (e: MessageEvent<EnhanceRequest>) => {
  const { id, buf, targetW } = e.data;
  try {
    const r = await render(buf, targetW);
    if ('skip' in r) {
      self.postMessage({ id, ok: false, skip: r.skip } satisfies EnhanceResponse);
      return;
    }
    self.postMessage({ id, ok: true, blob: r.blob, from: r.from, to: r.to } satisfies EnhanceResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /* 初始化/上下文错误是"这条路不能用"，不是某一页坏了；图片本身解码失败仍走 CPU 重试 */
    const gpuBroken = broken || (gl?.isContextLost() ?? false) || /webgl|shader|link|fbo|context/i.test(message);
    self.postMessage({ id, ok: false, error: message, gpuBroken });
  }
};
