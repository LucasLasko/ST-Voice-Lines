(() => {
  'use strict';

  const EXTENSION_NAME = 'ST Voice Lines';
  const HISTORY_WINDOW = 10;
  const TOKEN_DELAY_MS = 75;
  const MIN_DELAY_MS = 300;
  const MAX_DELAY_MS = 6000;

  const emotionAliases = {
    triste: ['triste', 'deprimido', 'deprimida', 'deprimido(a)', 'sem esperança', 'sem esperanca'],
    feliz: ['feliz', 'neutro', 'animado', 'animada'],
    bravo: ['bravo', 'furioso', 'furiosa', 'argumentativo', 'argumentativa'],
  };

  const voiceBank = {
    triste: [
      'Tudo vai ficar bem... um passo de cada vez.',
      'Entendo sua dor, estou aqui com você.',
      'Mesmo em dias escuros, ainda existe esperança.',
    ],
    feliz: [
      'Isso foi incrível, adorei!',
      'Que ótima notícia! Vamos continuar.',
      'Perfeito! Estou empolgado para o próximo passo.',
    ],
    bravo: [
      'Vamos focar e resolver isso agora.',
      'Ok, energia total: vamos argumentar com clareza.',
      'Respira. Transforme essa raiva em ação objetiva.',
    ],
  };

  const state = {
    recentEmotionHistory: [],
    recentVoiceLines: [],
  };

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function countTokens(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) {
      return 0;
    }

    return cleaned.split(/\s+/).length;
  }

  function delayFromTokens(tokenCount) {
    const rawDelay = tokenCount * TOKEN_DELAY_MS;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, rawDelay));
  }

  function rememberEmotion(emotion) {
    state.recentEmotionHistory.push(emotion);
    if (state.recentEmotionHistory.length > HISTORY_WINDOW) {
      state.recentEmotionHistory.splice(0, state.recentEmotionHistory.length - HISTORY_WINDOW);
    }
  }

  function rememberVoiceLine(voiceLine) {
    state.recentVoiceLines.push(voiceLine);
    if (state.recentVoiceLines.length > HISTORY_WINDOW) {
      state.recentVoiceLines.splice(0, state.recentVoiceLines.length - HISTORY_WINDOW);
    }
  }

  function classifyEmotionWithHeuristics(dialogue) {
    const normalized = normalizeText(dialogue);

    for (const [emotion, aliases] of Object.entries(emotionAliases)) {
      if (aliases.some((alias) => normalized.includes(normalizeText(alias)))) {
        return emotion;
      }
    }

    if (state.recentEmotionHistory.length > 0) {
      return state.recentEmotionHistory[state.recentEmotionHistory.length - 1];
    }

    return 'feliz';
  }

  async function classifyEmotion(dialogue) {
    // Integration hook for a future "Captioning AI" model.
    // If you register a handler on window.STVoiceLines.classifyEmotion,
    // this extension will call it and fallback to heuristic categorization.
    if (window.STVoiceLines?.classifyEmotion) {
      try {
        const externalEmotion = await window.STVoiceLines.classifyEmotion(dialogue);
        if (typeof externalEmotion === 'string' && voiceBank[externalEmotion]) {
          return externalEmotion;
        }
      } catch (error) {
        console.warn(`[${EXTENSION_NAME}] External classifier failed, fallback activated.`, error);
      }
    }

    return classifyEmotionWithHeuristics(dialogue);
  }

  function pickVoiceLine(emotion) {
    const available = voiceBank[emotion] || voiceBank.feliz;
    const nonRepeated = available.filter((line) => !state.recentVoiceLines.includes(line));

    const pool = nonRepeated.length > 0 ? nonRepeated : available;
    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
  }

  async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function playVoiceLine(voiceLine, metadata = {}) {
    // Generic event so other parts of ST can integrate with TTS/audio playback.
    document.dispatchEvent(
      new CustomEvent('st-voice-lines:play', {
        detail: {
          voiceLine,
          ...metadata,
        },
      }),
    );

    console.info(`[${EXTENSION_NAME}] ▶ ${voiceLine}`);
  }

  function splitDialogues(fullReply) {
    return String(fullReply || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function processDialogue(dialogue) {
    const tokenCount = countTokens(dialogue);
    const delayMs = delayFromTokens(tokenCount);

    const emotion = await classifyEmotion(dialogue);
    rememberEmotion(emotion);

    const voiceLine = pickVoiceLine(emotion);
    rememberVoiceLine(voiceLine);

    await wait(delayMs);
    await playVoiceLine(voiceLine, {
      emotion,
      tokenCount,
      delayMs,
      sourceDialogue: dialogue,
    });

    return {
      dialogue,
      emotion,
      tokenCount,
      delayMs,
      voiceLine,
    };
  }

  async function processAiReply(fullReply) {
    const dialogues = splitDialogues(fullReply);
    const results = [];

    for (const dialogue of dialogues) {
      const processed = await processDialogue(dialogue);
      results.push(processed);
    }

    return results;
  }

  function registerEventBridge() {
    // Default bridge: any system can dispatch this event with { text }.
    // It allows simultaneous user output + async voice line generation.
    document.addEventListener('st-voice-lines:reply', async (event) => {
      const replyText = event?.detail?.text;
      if (!replyText) return;

      try {
        await processAiReply(replyText);
      } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to process AI reply.`, error);
      }
    });
  }

  window.STVoiceLines = {
    ...window.STVoiceLines,
    config: {
      historyWindow: HISTORY_WINDOW,
      tokenDelayMs: TOKEN_DELAY_MS,
      minDelayMs: MIN_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
    },
    voiceBank,
    processAiReply,
    processDialogue,
    splitDialogues,
    countTokens,
  };

  registerEventBridge();
  console.info(`[${EXTENSION_NAME}] initialized.`);
})();
