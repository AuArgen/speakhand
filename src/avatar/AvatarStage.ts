// AvatarStage — React UI колдонгон ачык API: рендер, ойнотуу, жандуу мокап, тема.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { MocapFrame, SignClip } from "../lib/types";
import { neutralFace, type FaceState } from "./face";
import { IdleAnimator } from "./idle";
import {
  KeyframePlayer,
  MocapRetargeter,
  RigSolver,
  blendFaces,
  blendPoses,
  mocapDuration,
  newHandSample,
  sampleMocapClip,
  type HandSample,
} from "./retarget";
import { DEFAULT_AVATAR_URL, createProceduralAvatar, loadGLBAvatar, type AvatarRig, type Side } from "./rig";

export interface PlayItem {
  gloss: string;
  /** null → show caption only (unknown word) */
  clip: SignClip | null;
}

export interface PlayOptions {
  speed?: number;
  onItemStart?: (index: number, item: PlayItem) => void;
  signal?: AbortSignal;
}

export interface AvatarStageOptions {
  background?: "transparent" | string;
  /** Mixamo аталыштуу GLB аватар. Демейки: /models/avatar.glb; "" — GLB жүктөбөй, процедуралык аватар гана */
  avatarUrl?: string;
  theme?: "dark" | "light";
}

type Runtime =
  | { kind: "kf"; player: KeyframePlayer; duration: number }
  | { kind: "mocap"; clip: import("../lib/types").MocapClip; start: number; duration: number }
  | { kind: "none"; duration: number };

interface Playback {
  items: PlayItem[];
  idx: number;
  t: number;
  speed: number;
  opts: PlayOptions;
  rt: Runtime | null;
  resolve: () => void;
  onAbort?: () => void;
}

const FADE_BETWEEN = 220;
const FADE_FROM_IDLE = 300;
const FADE_TO_IDLE = 420;
const CAPTION_ONLY_MS = 900;

export class AvatarStage {
  readonly ready: Promise<void>;

  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  private controls: OrbitControls;
  private pmrem: THREE.PMREMGenerator;
  private envTex: THREE.Texture | null = null;
  private ro: ResizeObserver;
  private raf = 0;
  private lastTime = 0;
  private disposed = false;
  private theme: "dark" | "light" = "dark";

  private rig: AvatarRig | null = null;
  private solver: RigSolver | null = null;
  private idle: IdleAnimator | null = null;
  private mocap: MocapRetargeter | null = null;

  private target: Float32Array | null = null;
  private display: Float32Array | null = null;
  private fadeFrom: Float32Array | null = null;
  private faceTarget: FaceState = neutralFace();
  private faceDisplay: FaceState = neutralFace();
  private faceFrom: FaceState = neutralFace();
  private fadeT = 1;
  private fadeDur = 1;
  /** Сөөк боюнча кроссфейд маскасы: 1 = аралаштыр, 0 = максатты түз колдон (кол чынжырлары өз жаасы менен өтөт) */
  private fadeMask: Float32Array | null = null;
  private armMask: Float32Array | null = null;
  /** Кадрдын аягындагы колдордун абалы — кийинки жест/тынч абалга жаа менен өтүү үчүн */
  private lastSamples: Record<Side, HandSample> = { Left: newHandSample(), Right: newHandSample() };
  private samplesValid = false;

  private playback: Playback | null = null;
  private live: MocapFrame | null = null;
  private liveFresh = false;

  private lights: { key: THREE.DirectionalLight; fill: THREE.DirectionalLight; rimA: THREE.DirectionalLight; rimB: THREE.DirectionalLight; hemi: THREE.HemisphereLight };
  private halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private shadowCatcher: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private framing = { center: new THREE.Vector3(0, 1.36, 0), height: 1.02, width: 1.1 };
  private homeOffset = new THREE.Vector3(0, 0.1, 1);
  private lastInteract = -1e9;
  private onVis = () => this.handleVisibility();

  constructor(container: HTMLElement, opts: AvatarStageOptions = {}) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    const bg = opts.background ?? "transparent";
    if (bg === "transparent") renderer.setClearColor(0x000000, 0);
    else renderer.setClearColor(new THREE.Color(bg), 1);
    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.setAttribute("aria-label", "3D жест аватары");
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(canvas);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTex = this.pmrem.fromScene(room, 0.04).texture;
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.55;

    // ---- Жарык: жумшак жылуу негизги (сол-жогору-алды), жылуу толтуруучу (оң-төмөн), муздак контур (арт) ----
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x4a3b3a, 0.5);
    // Негизги жарык: жогору-капталдан (Рембрандт стили) — бет жана колдор көлөмдүү көрүнөт
    const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
    key.position.set(-1.7, 3.0, 1.9);
    key.target.position.set(0, 1.3, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -0.75;
    sc.right = 0.75;
    sc.top = 0.75;
    sc.bottom = -0.75;
    sc.near = 1.5;
    sc.far = 5.5;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.01;
    key.shadow.radius = 5;
    key.shadow.blurSamples = 10;
    const fill = new THREE.DirectionalLight(0xffd6bc, 0.75);
    fill.position.set(2.2, 1.2, 1.6);
    fill.target.position.set(0, 1.3, 0);
    const rimA = new THREE.DirectionalLight(0xb9d4ff, 2.6);
    rimA.position.set(1.5, 2.3, -2.2);
    rimA.target.position.set(0, 1.3, 0);
    const rimB = new THREE.DirectionalLight(0xffd0b0, 1.2);
    rimB.position.set(-1.9, 1.8, -1.9);
    rimB.target.position.set(0, 1.3, 0);
    for (const l of [key, fill, rimA, rimB]) this.scene.add(l, l.target);
    this.scene.add(hemi);
    this.lights = { key, fill, rimA, rimB, hemi };

    // ---- Арткы нур (halo) жана жумшак көлөкө ----
    const haloMat = new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, toneMapped: false, opacity: 0.5 });
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), haloMat);
    this.halo.position.set(0, 1.42, -0.55);
    this.halo.renderOrder = -1;
    this.scene.add(this.halo);
    const shadowMat = new THREE.MeshBasicMaterial({ map: radialTexture(true), transparent: true, depthWrite: false, opacity: 0.35, color: 0x000000 });
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), shadowMat);
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.set(0, 0.79, 0.02);
    this.scene.add(this.shadowCatcher);

    // ---- Камера / башкаруу ----
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.45;
    this.controls.minAzimuthAngle = -0.6;
    this.controls.maxAzimuthAngle = 0.6;
    this.controls.minPolarAngle = Math.PI / 2 - 0.42;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.12;
    this.controls.addEventListener("start", () => (this.lastInteract = Infinity));
    this.controls.addEventListener("end", () => (this.lastInteract = performance.now()));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    document.addEventListener("visibilitychange", this.onVis);
    this.setTheme(opts.theme ?? "dark");

    // Процедуралык аватар дароо; GLB берилсе, жүктөлгөндөн кийин алмаштырылат
    this.installRig(createProceduralAvatar());
    this.resize();
    this.ready = (async () => {
      const url = opts.avatarUrl ?? DEFAULT_AVATAR_URL;
      if (url) {
        try {
          const glb = await loadGLBAvatar(url);
          if (this.disposed) {
            glb.dispose();
            return;
          }
          this.installRig(glb);
        } catch (e) {
          console.warn("[AvatarStage] GLB жүктөлгөн жок, процедуралык аватар колдонулат:", e);
        }
      }
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    })();
    this.start();
  }

  // -------------------------------------------------------------------------
  // Ачык API
  // -------------------------------------------------------------------------

  /** Plays items one after another with smooth 150-250ms transitions between signs, returns to idle when done. */
  play(items: PlayItem[], opts: PlayOptions = {}): Promise<void> {
    this.finishPlayback(false);
    if (!items.length || opts.signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const pb: Playback = { items, idx: -1, t: 0, speed: Math.max(0.1, opts.speed ?? 1), opts, rt: null, resolve };
      if (opts.signal) {
        pb.onAbort = () => {
          if (this.playback === pb) this.finishPlayback(true);
        };
        opts.signal.addEventListener("abort", pb.onAbort, { once: true });
      }
      this.playback = pb;
      this.nextItem();
    });
  }

  stop(): void {
    this.finishPlayback(true);
  }

  /** Live puppeteering: mirror a live MocapFrame onto the avatar. Pass null to release. */
  setLiveFrame(frame: MocapFrame | null): void {
    if (frame && !this.live) {
      this.mocap?.reset();
      this.handOffArms(["Left", "Right"], FADE_BETWEEN);
      this.startFade(FADE_BETWEEN, this.samplesValid);
    } else if (!frame && this.live) {
      this.handOffArms(["Left", "Right"], FADE_TO_IDLE);
      this.startFade(FADE_TO_IDLE, this.samplesValid);
    }
    this.live = frame;
    this.liveFresh = !!frame;
  }

  getTheme(): "dark" | "light" {
    return this.theme;
  }

  setTheme(theme: "dark" | "light"): void {
    this.theme = theme;
    const dark = theme === "dark";
    this.halo.material.color.set(dark ? 0x6d8cff : 0xffffff);
    this.halo.material.opacity = dark ? 0.32 : 0.75;
    this.shadowCatcher.material.opacity = dark ? 0.45 : 0.22;
    this.lights.rimA.color.set(dark ? 0xa9c6ff : 0xcfe0ff);
    this.lights.key.intensity = dark ? 2.5 : 2.2;
    this.lights.rimA.intensity = dark ? 2.6 : 1.6;
    this.lights.rimB.intensity = dark ? 1.2 : 0.8;
    this.lights.fill.intensity = dark ? 0.55 : 0.8;
    this.lights.hemi.intensity = dark ? 0.35 : 0.55;
    this.scene.environmentIntensity = dark ? 0.45 : 0.55;
    this.renderer.toneMappingExposure = dark ? 1.02 : 0.98;
  }

  dispose(): void {
    if (this.disposed) return;
    this.finishPlayback(false);
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVis);
    this.ro.disconnect();
    this.controls.dispose();
    this.rig?.dispose();
    this.halo.geometry.dispose();
    this.halo.material.map?.dispose();
    this.halo.material.dispose();
    this.shadowCatcher.geometry.dispose();
    this.shadowCatcher.material.map?.dispose();
    this.shadowCatcher.material.dispose();
    this.envTex?.dispose();
    this.pmrem.dispose();
    for (const l of Object.values(this.lights)) if (l instanceof THREE.DirectionalLight) l.shadow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // -------------------------------------------------------------------------
  // Ички
  // -------------------------------------------------------------------------

  private installRig(rig: AvatarRig) {
    if (this.rig) this.rig.dispose();
    this.rig = rig;
    this.scene.add(rig.root);
    this.solver = new RigSolver(rig);
    this.idle = new IdleAnimator(this.solver);
    this.mocap = new MocapRetargeter(this.solver);
    const n = this.solver.order.length * 4;
    this.target = new Float32Array(n);
    this.display = new Float32Array(n);
    this.fadeFrom = new Float32Array(n);
    this.fadeMask = new Float32Array(this.solver.order.length).fill(1);
    this.armMask = new Float32Array(this.solver.order.length).fill(1);
    for (const side of ["Left", "Right"] as const) for (const inf of this.solver.chain(side)) this.armMask[this.solver.boneIndex(inf.name)] = 0;
    this.samplesValid = false;
    // Камераны ригге жараша
    const s = this.solver;
    // Белден өйдө композиция: төмөнкү чеги жамбаштын бир аз үстүндө (тынч колдор толук көрүнөт,
    // шымдын бели кадрдан тышкары), баштын үстүндө ~10 см боштук
    const head = s.restPos("Head");
    const hips = s.hipsRest;
    const top = head.y + 0.32 * s.scale;
    const bottom = hips.y - 0.04 * s.scale;
    this.framing.center.set(0, (top + bottom) / 2, 0);
    this.framing.height = top - bottom;
    this.framing.width = 0.98 * s.scale;
    this.shadowCatcher.position.y = hips.y - 0.21 * s.scale;
    this.halo.position.y = (top + bottom) / 2 + 0.06;
    this.computeTarget(0);
    this.display.set(this.target);
    this.solver.write(this.display);
    this.fadeT = 1;
    this.frameCamera(true);
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameCamera(true);
    if (!this.raf && !this.disposed) this.renderOnce();
  }

  private frameCamera(reset: boolean) {
    const f = this.framing;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distH = f.height / 2 / tanV;
    const distW = f.width / 2 / (tanV * this.camera.aspect);
    const dist = Math.max(distH, distW) * 1.04;
    this.homeOffset.set(0, dist * 0.1, dist);
    this.controls.target.copy(f.center);
    if (reset) {
      this.camera.position.copy(f.center).add(this.homeOffset);
      this.camera.lookAt(f.center);
    }
    this.controls.minDistance = dist * 0.98;
    this.controls.maxDistance = dist * 1.02;
    this.controls.update();
  }

  private start() {
    if (this.raf || this.disposed) return;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.tick(dt, now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private handleVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else this.start();
  }

  private renderOnce() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Сөөк мейкиндигинде кроссфейд. `skipArms` — кол чынжырлары өз (дене-аң-сезимдүү) өткөөлү менен барат */
  private startFade(ms: number, skipArms = false) {
    if (!this.display || !this.fadeFrom || !this.fadeMask) return;
    this.fadeFrom.set(this.display);
    Object.assign(this.faceFrom, this.faceDisplay);
    this.fadeT = 0;
    this.fadeDur = Math.max(1, ms);
    if (skipArms && this.armMask) this.fadeMask.set(this.armMask);
    else this.fadeMask.fill(1);
  }

  /** Колдордун учурдагы абалын кийинки булакка өткөрүү (жест ↔ жест, жест ↔ тынч абал) */
  private handOffArms(sidesToIdle: readonly Side[], ms: number) {
    if (!this.idle || !this.samplesValid) return;
    for (const side of sidesToIdle) this.idle.setEntry(side, this.lastSamples[side], ms);
  }

  private nextItem() {
    const pb = this.playback;
    if (!pb || !this.solver) return;
    pb.idx++;
    if (pb.idx >= pb.items.length) {
      this.finishPlayback(true);
      return;
    }
    const item = pb.items[pb.idx];
    pb.t = 0;
    const clip = item.clip;
    const fadeMs = pb.idx === 0 ? FADE_FROM_IDLE : FADE_BETWEEN;
    const toIdle: Side[] = ["Left", "Right"];
    if (!clip) pb.rt = { kind: "none", duration: CAPTION_ONLY_MS };
    else if (clip.kind === "keyframe") {
      const player = new KeyframePlayer(this.solver, clip);
      pb.rt = { kind: "kf", player, duration: player.duration };
      if (this.samplesValid) {
        // Кирүү өткөөлү клиптин өз убактысында (ылдамдыкка жараша), бирок окула турган чекте
        player.setEntry(this.lastSamples, THREE.MathUtils.clamp(fadeMs * pb.speed, 120, 600));
        toIdle.length = 0;
        for (const s of ["Left", "Right"] as const) if (!player.hasHand(s)) toIdle.push(s);
      }
    } else {
      this.mocap?.reset();
      pb.rt = { kind: "mocap", clip, start: clip.frames[0]?.t ?? 0, duration: mocapDuration(clip) };
    }
    this.handOffArms(toIdle, fadeMs);
    this.startFade(fadeMs, this.samplesValid);
    try {
      pb.opts.onItemStart?.(pb.idx, item);
    } catch (e) {
      console.error(e);
    }
  }

  private finishPlayback(fadeToIdle: boolean) {
    const pb = this.playback;
    if (!pb) return;
    this.playback = null;
    if (pb.onAbort) pb.opts.signal?.removeEventListener("abort", pb.onAbort);
    if (fadeToIdle) {
      this.handOffArms(["Left", "Right"], FADE_TO_IDLE);
      this.startFade(FADE_TO_IDLE, this.samplesValid);
    }
    pb.resolve();
  }

  /** Учурдагы булактан максаттуу позаны эсептейт (this.target / this.faceTarget) */
  private computeTarget(dt: number) {
    const sv = this.solver!;
    const idle = this.idle!;
    const face = this.faceTarget;
    Object.assign(face, neutralFace());
    sv.beginFrame();
    sv.resetPose();
    const restArm = (side: Side) => idle.applyRestArm(side);

    if (this.live && this.mocap) {
      idle.applyBody(0.5);
      const t = performance.now() / 1000;
      this.mocap.apply(this.live, t, dt, this.liveFresh, face, restArm);
      this.liveFresh = false;
      idle.applyHead(0.3);
      idle.applyFace(face, 0.4);
    } else if (this.playback?.rt) {
      const pb = this.playback;
      const rt = pb.rt!;
      idle.applyBody(0.6);
      if (rt.kind === "kf") rt.player.apply(pb.t, face, restArm);
      else if (rt.kind === "mocap" && this.mocap) {
        const fr = sampleMocapClip(rt.clip, rt.start + pb.t);
        if (fr) this.mocap.apply(fr, pb.t / 1000, dt, true, face, restArm);
        else for (const s of ["Left", "Right"] as const) restArm(s);
      } else for (const s of ["Left", "Right"] as const) restArm(s);
      idle.applyHead(0.35);
      idle.applyFace(face, 0.5);
    } else {
      idle.applyBody(1);
      restArm("Left");
      restArm("Right");
      idle.applyHead(1);
      idle.applyFace(face, 1);
    }
    sv.capture(this.target!);
  }

  private tick(dt: number, now: number) {
    if (!this.solver || !this.idle) return;
    this.idle.update(dt);

    // Ойнотуу убактысы
    const pb = this.playback;
    if (pb && pb.rt) {
      pb.t += dt * 1000 * pb.speed;
      if (pb.t >= pb.rt.duration) {
        this.nextItem();
      }
    }

    this.computeTarget(dt);

    // Кроссфейд
    if (this.fadeT < 1) {
      this.fadeT = Math.min(1, this.fadeT + (dt * 1000) / this.fadeDur);
      const e = easeInOut(this.fadeT);
      blendPoses(this.fadeFrom!, this.target!, e, this.display!, this.fadeMask ?? undefined);
      blendFaces(this.faceFrom, this.faceTarget, e, this.faceDisplay);
    } else {
      this.display!.set(this.target!);
      Object.assign(this.faceDisplay, this.faceTarget);
    }
    this.solver.write(this.display!);
    this.rig?.face?.apply(this.faceDisplay);

    // Камера: колдонуучу тийбесе акырын алдыңкы көрүнүшкө кайтат
    if (now - this.lastInteract > 3500) {
      const home = this.framing.center.clone().add(this.homeOffset);
      this.camera.position.lerp(home, 1 - Math.exp(-dt / 0.9));
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    // Көрсөтүлгөн колдордун абалын эстеп калуу (кийинки өткөөл ушундан башталат)
    for (const side of ["Left", "Right"] as const) this.solver.readHandSample(side, this.lastSamples[side]);
    this.samplesValid = true;
  }
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function radialTexture(shadow = false): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  if (shadow) {
    grd.addColorStop(0, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.5, "rgba(255,255,255,0.35)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
  } else {
    grd.addColorStop(0, "rgba(255,255,255,0.85)");
    grd.addColorStop(0.35, "rgba(255,255,255,0.35)");
    grd.addColorStop(0.7, "rgba(255,255,255,0.08)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
  }
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
