/**
 * Worklet de capture. Tourne sur le thread audio temps réel : il se contente de
 * recopier les échantillons et de transmettre le niveau sonore, sans allouer
 * plus que nécessaire — tout traitement lourd ici provoquerait des coupures.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.framesSinceLevel = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'start') this.recording = true;
      else if (event.data === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    if (this.recording) {
      // Copie obligatoire : le buffer fourni est réutilisé au bloc suivant
      this.port.postMessage({ type: 'chunk', data: new Float32Array(channel) }, []);
    }

    // Niveau sonore envoyé ~20 fois par seconde, suffisant pour animer l'overlay
    this.framesSinceLevel += channel.length;
    if (this.framesSinceLevel >= 800) {
      this.framesSinceLevel = 0;
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < channel.length; i += 1) {
        const v = channel[i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      this.port.postMessage({ type: 'level', rms: Math.sqrt(sum / channel.length), peak });
    }

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
