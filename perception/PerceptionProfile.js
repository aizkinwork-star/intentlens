// perception/PerceptionProfile.js — versioned, configurable perception thresholds.
export const PROFILES = {
  performance: {
    name: 'performance',
    redetectMaxFrames: 120,
    survivalThreshold: 0.4,
    fbErrorThreshold: 20,
    ransacInlierMin: 6,
    inlierRatioMin: 0.3,
    spreadMin: 0.2,
    maxFlowPoints: 30,
    morphKernelSize: 3,
  },
  balanced: {
    name: 'balanced',
    redetectMaxFrames: 90,
    survivalThreshold: 0.5,
    fbErrorThreshold: 15,
    ransacInlierMin: 8,
    inlierRatioMin: 0.4,
    spreadMin: 0.3,
    maxFlowPoints: 50,
    morphKernelSize: 3,
  },
  accuracy: {
    name: 'accuracy',
    redetectMaxFrames: 60,
    survivalThreshold: 0.6,
    fbErrorThreshold: 10,
    ransacInlierMin: 12,
    inlierRatioMin: 0.5,
    spreadMin: 0.4,
    maxFlowPoints: 80,
    morphKernelSize: 5,
  },
};

export class PerceptionProfile {
  constructor(profileName = 'balanced') {
    this.name = profileName;
    this.config = { ...PROFILES[profileName] || PROFILES.balanced };
    this.version = '1.0';
    this.metrics = {
      fps: 0, frameTime: 0, survivalRatio: 0, fbError: 0,
      ransacInliers: 0, reprojectionError: 0, redetectCount: 0,
      trackLossCount: 0, recoveryCount: 0,
    };
  }

  setProfile(name) {
    if (PROFILES[name]) {
      this.name = name;
      this.config = { ...PROFILES[name] };
    }
  }

  // Normalize thresholds by image dimensions.
  normalizeThresholds(width, height) {
    const scale = Math.sqrt(width * height) / 1000;
    return {
      ...this.config,
      fbErrorThreshold: this.config.fbErrorThreshold * scale,
      survivalThreshold: this.config.survivalThreshold,
    };
  }

  updateMetrics(m) {
    Object.assign(this.metrics, m);
  }

  toJSON() { return { version: this.version, profile: this.name, config: this.config, metrics: this.metrics }; }
}