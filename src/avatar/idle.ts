// Тынч абалдагы "жандуу" кыймылдар: дем алуу, баштын майда кыймылы, көз ирмөө, көз чуркоо.
import * as THREE from "three";
import type { FaceState } from "./face";
import {
  applyHandSample,
  blendHandSamples,
  copyHandSample,
  newHandSample,
  resolveHandTarget,
  restTarget,
  type HandSample,
  type RigSolver,
} from "./retarget";
import { SIDES, type Side } from "./rig";

const smooth = (u: number) => u * u * (3 - 2 * u);

interface RestEntry {
  sample: HandSample;
  t0: number;
  ms: number;
}

export class IdleAnimator {
  private t = Math.random() * 100;
  private nextBlink = 1.5;
  private blinkT = -1;
  private doubleBlink = false;
  private look = new THREE.Vector2();
  private lookTarget = new THREE.Vector2();
  private nextLook = 1;
  private rest: Record<Side, HandSample>;
  private entry: Partial<Record<Side, RestEntry>> = {};
  private tmp = newHandSample();
  private cur = newHandSample();

  constructor(private solver: RigSolver) {
    this.rest = {} as Record<Side, HandSample>;
    for (const side of SIDES) this.rest[side] = resolveHandTarget(solver, side, restTarget(side));
  }

  /** Тынч абалдагы колдун үлгүсү */
  restSample(side: Side): HandSample {
    return this.rest[side];
  }

  /** Кол `sample` абалынан тынч абалга `ms` ичинде дененин айланасында жаа менен кайтат */
  setEntry(side: Side, sample: HandSample | undefined, ms: number): void {
    if (!sample || ms <= 0) {
      delete this.entry[side];
      return;
    }
    this.entry[side] = { sample: copyHandSample(sample, newHandSample()), t0: this.t, ms };
  }

  update(dt: number): void {
    this.t += dt;
    // Ирмөө
    this.nextBlink -= dt;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      if (this.blinkT > 0.2) {
        this.blinkT = -1;
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.nextBlink = 0.08;
        }
      }
    } else if (this.nextBlink <= 0) {
      this.blinkT = 0;
      this.doubleBlink = Math.random() < 0.18;
      this.nextBlink = 2.2 + Math.random() * 3.6;
    }
    // Көз чуркоо (saccade)
    this.nextLook -= dt;
    if (this.nextLook <= 0) {
      this.nextLook = 0.7 + Math.random() * 2.4;
      const center = Math.random() < 0.55;
      this.lookTarget.set(center ? 0 : (Math.random() - 0.5) * 0.36, center ? 0 : (Math.random() - 0.5) * 0.22);
    }
    this.look.lerp(this.lookTarget, 1 - Math.exp(-dt / 0.045));
  }

  /** Дем алуу менен тулкунун майда чайкалышы (колдор чечилгенге чейин колдонулат) */
  applyBody(weight = 1): void {
    const sv = this.solver;
    const t = this.t;
    const breath = Math.sin((t * Math.PI * 2) / 4.3);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    // Жамбаш: салмакты бир бутка жылдыруу
    e.set(0, 0.012 * Math.sin(t * 0.21) * weight, 0.01 * Math.sin(t * 0.17 + 1) * weight);
    sv.rotateWorld("Hips", q.setFromEuler(e));
    // Омуртка: компенсация + дем (көкүрөк көтөрүлөт)
    e.set(-0.012 * breath * weight, -0.008 * Math.sin(t * 0.21) * weight, -0.012 * Math.sin(t * 0.17 + 1) * weight);
    sv.rotateWorld("Spine", q.setFromEuler(e), 0.5);
    sv.rotateWorld("Spine2", q.setFromEuler(e), 0.5);
    this.breath = breath * weight;
  }
  private breath = 0;

  /** Тынч колдор (белдин алдында), дем менен бир аз кыймылдайт; керек болсо мурунку абалдан жаа менен келет */
  applyRestArm(side: Side): void {
    const r = this.rest[side];
    const s = side === "Left" ? 1 : -1;
    const target = this.tmp;
    copyHandSample(r, target);
    target.pos.add(new THREE.Vector3(0.004 * s * Math.sin(this.t * 0.5 + s), 0.005 * this.breath, 0.004 * Math.sin(this.t * 0.37 + s)));
    let sample = target;
    const en = this.entry[side];
    if (en) {
      const u = ((this.t - en.t0) * 1000) / en.ms;
      if (u >= 1) delete this.entry[side];
      else sample = blendHandSamples(this.solver, en.sample, target, smooth(Math.max(0, u)), this.cur);
    }
    this.solver.shrug(side, 0.012 * this.breath, 0);
    applyHandSample(this.solver, side, sample);
  }

  applyHead(weight = 1): void {
    const t = this.t;
    const yaw = (0.045 * Math.sin(t * 0.31) + 0.02 * Math.sin(t * 0.73 + 1.3)) * weight;
    const pitch = (0.025 * Math.sin(t * 0.41 + 2) + 0.012 * Math.sin(t * 1.1)) * weight - 0.02 * weight;
    const roll = 0.02 * Math.sin(t * 0.23 + 0.5) * weight;
    this.solver.headRotate(pitch, yaw, roll);
  }

  applyFace(face: FaceState, weight = 1): void {
    if (this.blinkT >= 0) {
      const b = this.blinkT < 0.07 ? this.blinkT / 0.07 : Math.max(0, 1 - (this.blinkT - 0.07) / 0.13);
      face.eyeBlinkLeft = Math.max(face.eyeBlinkLeft, b);
      face.eyeBlinkRight = Math.max(face.eyeBlinkRight, b);
    }
    face.eyeLookX += this.look.x * weight;
    face.eyeLookY += this.look.y * weight;
    // Жеңил жылмаюу — достук маанай
    face.mouthSmileLeft = Math.max(face.mouthSmileLeft, 0.12 * weight);
    face.mouthSmileRight = Math.max(face.mouthSmileRight, 0.12 * weight);
  }
}
