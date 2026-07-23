/**
 * 数据模型层：枚举与数据结构
 * 所有插件内共享的数据结构定义。
 */

// ============================================================
// Enums (as const objects for strict TS)
// ============================================================

export const TodoType = {
  INTERNAL: "need_todo",
  SOCIAL: "social_todo",
} as const;
export type TodoTypeValue = (typeof TodoType)[keyof typeof TodoType];

export const InteractionMode = {
  ACTIVE: "active",
  PASSIVE: "passive",
} as const;
export type InteractionModeValue = (typeof InteractionMode)[keyof typeof InteractionMode];

export const InteractionOutcome = {
  CONNECTED: "connected",
  MISSED: "missed",
  AWKWARD: "awkward",
  RELIEF: "relief",
} as const;
export type InteractionOutcomeValue = (typeof InteractionOutcome)[keyof typeof InteractionOutcome];

// ============================================================
// Compatibility helper
// ============================================================

function safeFromDict<T>(cls: new () => T, d: Record<string, unknown>): T {
  const instance = new cls();
  for (const key of Object.keys(instance as Record<string, unknown>)) {
    if (key in d) {
      (instance as Record<string, unknown>)[key] = d[key];
    }
  }
  return instance;
}

// ============================================================
// Models
// ============================================================

export class EmotionState {
  energy = 80.0;
  mood = 70.0;
  socialNeed = 50.0;
  lastUpdate = Date.now() / 1000;

  toDict(): Record<string, unknown> {
    return {
      energy: this.energy,
      mood: this.mood,
      socialNeed: this.socialNeed,
      lastUpdate: this.lastUpdate,
    };
  }

  static fromDict(d: Record<string, unknown>): EmotionState {
    return safeFromDict(EmotionState, d);
  }

  decay(amount: number): void {
    this.energy = Math.max(0.0, this.energy - amount);
    this.mood = Math.max(0.0, this.mood - amount * 0.8);
    this.socialNeed = Math.min(100.0, this.socialNeed + amount * 0.5);
    this.lastUpdate = Date.now() / 1000;
  }

  onInteract(recovery: number): void {
    this.energy = Math.min(100.0, this.energy + recovery);
    this.mood = Math.min(100.0, this.mood + recovery * 1.2);
    this.socialNeed = Math.max(0.0, this.socialNeed - recovery);
    this.lastUpdate = Date.now() / 1000;
  }

  narrative(): string {
    const parts: string[] = [];
    if (this.energy < 20) {
      parts.push("累到不想动");
    } else if (this.energy < 50) {
      parts.push("有点疲惫");
    } else if (this.energy > 80) {
      parts.push("精力充沛");
    }

    if (this.mood < 20) {
      parts.push("心情低落");
    } else if (this.mood < 50) {
      parts.push("兴致不高");
    } else if (this.mood > 80) {
      parts.push("心情很好");
    }

    if (this.socialNeed > 80) {
      parts.push("很想找人说话");
    } else if (this.socialNeed > 50) {
      parts.push("有点想聊天");
    }

    if (parts.length === 0) {
      return "状态平稳";
    }
    return parts.join("，");
  }

  statusStr(): string {
    return `活力: ${this.energy.toFixed(0)}/100 | 心情: ${this.mood.toFixed(0)}/100 | 社交需求: ${this.socialNeed.toFixed(0)}/100`;
  }
}

export class UserProfile {
  userId = "";
  nickname = "";
  firstSeen = Date.now() / 1000;
  lastSeen = Date.now() / 1000;
  chatCount = 0;
  notes = "";
  affinity = 50.0;

  toDict(): Record<string, unknown> {
    return {
      userId: this.userId,
      nickname: this.nickname,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      chatCount: this.chatCount,
      notes: this.notes,
      affinity: this.affinity,
    };
  }

  static fromDict(d: Record<string, unknown>): UserProfile {
    return safeFromDict(UserProfile, d);
  }
}

export class ChatTurn {
  role = "";
  content = "";
  timestamp = Date.now() / 1000;

  toDict(): Record<string, unknown> {
    return {
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
    };
  }

  static fromDict(d: Record<string, unknown>): ChatTurn {
    return safeFromDict(ChatTurn, d);
  }
}

export class Effect {
  id = "";
  effectType = "";
  intensity = 0.0;
  sourceDetail = "";
  decayStyle = "";
  recoveryStyle = "";
  createdAt = 0.0;
  expiresAt = 0.0;

  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      effectType: this.effectType,
      intensity: this.intensity,
      sourceDetail: this.sourceDetail,
      decayStyle: this.decayStyle,
      recoveryStyle: this.recoveryStyle,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
    };
  }

  static fromDict(d: Record<string, unknown>): Effect {
    return safeFromDict(Effect, d);
  }

  currentIntensity(now: number): number {
    if (now >= this.expiresAt) {
      return 0.0;
    }
    const total = this.expiresAt - this.createdAt;
    if (total <= 0) {
      return this.intensity;
    }
    const elapsed = now - this.createdAt;
    const ratio = elapsed / total;

    if (this.decayStyle === "fast") {
      if (ratio < 0.3) {
        return this.intensity * (1 - (ratio / 0.3) * 0.8);
      } else {
        return this.intensity * 0.2 * (1 - (ratio - 0.3) / 0.7);
      }
    } else if (this.decayStyle === "slow") {
      if (ratio < 0.5) {
        return this.intensity * (1 - ratio);
      } else {
        return this.intensity * 0.5 * (1 - (ratio - 0.5) / 0.5 * 0.5);
      }
    } else {
      return this.intensity * (1 - ratio);
    }
  }

  narrative(now: number): string {
    const intensity = this.currentIntensity(now);
    if (intensity < 10) {
      return "";
    }
    let strength: string;
    if (intensity > 60) {
      strength = "强烈";
    } else if (intensity > 30) {
      strength = "有些";
    } else {
      strength = "淡淡的";
    }
    return `${strength}${this.sourceDetail}`;
  }
}

export class Todo {
  id = "";
  todoType = "";
  content = "";
  createdAt = 0.0;
  priority = 0;
  done = false;

  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      todoType: this.todoType,
      content: this.content,
      createdAt: this.createdAt,
      priority: this.priority,
      done: this.done,
    };
  }

  static fromDict(d: Record<string, unknown>): Todo {
    return safeFromDict(Todo, d);
  }
}

export class InteractionEvent {
  mode = "";
  outcome = "";
  timestamp = Date.now() / 1000;

  toDict(): Record<string, unknown> {
    return {
      mode: this.mode,
      outcome: this.outcome,
      timestamp: this.timestamp,
    };
  }

  static fromDict(d: Record<string, unknown>): InteractionEvent {
    return safeFromDict(InteractionEvent, d);
  }
}

export class Consolidation {
  date = "";
  connectedCount = 0;
  missedCount = 0;
  activeCount = 0;
  passiveCount = 0;
  awkwardCount = 0;
  reliefCount = 0;
  trajectory = "flat";
  shiftHint = "";

  toDict(): Record<string, unknown> {
    return {
      date: this.date,
      connectedCount: this.connectedCount,
      missedCount: this.missedCount,
      activeCount: this.activeCount,
      passiveCount: this.passiveCount,
      awkwardCount: this.awkwardCount,
      reliefCount: this.reliefCount,
      trajectory: this.trajectory,
      shiftHint: this.shiftHint,
    };
  }

  static fromDict(d: Record<string, unknown>): Consolidation {
    return safeFromDict(Consolidation, d);
  }
}

export class ProfileFact {
  id = "";
  category = "";
  content = "";
  evidence = "";
  confidence = 1.0;
  createdAt = Date.now() / 1000;

  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      category: this.category,
      content: this.content,
      evidence: this.evidence,
      confidence: this.confidence,
      createdAt: this.createdAt,
    };
  }

  static fromDict(d: Record<string, unknown>): ProfileFact {
    return safeFromDict(ProfileFact, d);
  }
}

export class ReflectionRecord {
  id = "";
  trigger = "";
  note = "";
  factsStr = "";
  bias = "";
  createdAt = Date.now() / 1000;
  consumed = false;

  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      trigger: this.trigger,
      note: this.note,
      factsStr: this.factsStr,
      bias: this.bias,
      createdAt: this.createdAt,
      consumed: this.consumed,
    };
  }

  static fromDict(d: Record<string, unknown>): ReflectionRecord {
    return safeFromDict(ReflectionRecord, d);
  }

  explicitFacts(): string[] {
    if (!this.factsStr) {
      return [];
    }
    return this.factsStr
      .split("|")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }
}
