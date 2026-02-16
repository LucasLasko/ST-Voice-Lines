(() => {
  'use strict';

  const EXTENSION_NAME = 'ST Voice Lines';
  const HISTORY_WINDOW = 10;
  const TOKEN_DELAY_MS = 75;
  const MIN_DELAY_MS = 300;
  const MAX_DELAY_MS = 6000;

  const STORAGE_KEYS = {
    apiKey: 'st-voice-lines:captioning-api-key',
    voiceBank: 'st-voice-lines:voice-bank',
  };

  const emotionAliases = {
    triste: ['triste', 'deprimido', 'deprimida', 'deprimido(a)', 'sem esperança', 'sem esperanca'],
    feliz: ['feliz', 'neutro', 'animado', 'animada'],
    bravo: ['bravo', 'furioso', 'furiosa', 'argumentativo', 'argumentativa'],
  };

  const defaultVoiceBank = {
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
    apiKey: '',
    voiceBank: structuredClone(defaultVoiceBank),
    selectedEmotion: 'triste',
  };

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function readStorage(key, fallbackValue) {
    const stored = localStorage.getItem(key);
    if (!stored) return fallbackValue;

    try {
      return JSON.parse(stored);
    } catch (error) {
      console.warn(`[${EXTENSION_NAME}] Failed to parse storage key ${key}.`, error);
      return fallbackValue;
    }
  }

  function writeStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadSettings() {
    state.apiKey = readStorage(STORAGE_KEYS.apiKey, '') || '';

    const customVoiceBank = readStorage(STORAGE_KEYS.voiceBank, null);
    if (customVoiceBank && typeof customVoiceBank === 'object') {
      for (const emotion of Object.keys(defaultVoiceBank)) {
        if (Array.isArray(customVoiceBank[emotion])) {
          state.voiceBank[emotion] = customVoiceBank[emotion].filter((line) => typeof line === 'string' && line.trim());
        }
      }
    }
  }

  function saveVoiceBank() {
    writeStorage(STORAGE_KEYS.voiceBank, state.voiceBank);
  }

  function countTokens(text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) return 0;
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
    if (window.STVoiceLines?.classifyEmotion) {
      try {
        const externalEmotion = await window.STVoiceLines.classifyEmotion(dialogue, {
          apiKey: state.apiKey,
          availableEmotions: Object.keys(state.voiceBank),
        });

        if (typeof externalEmotion === 'string' && state.voiceBank[externalEmotion]) {
          return externalEmotion;
        }
      } catch (error) {
        console.warn(`[${EXTENSION_NAME}] External classifier failed, fallback activated.`, error);
      }
    }

    return classifyEmotionWithHeuristics(dialogue);
  }

  function pickVoiceLine(emotion) {
    const available = state.voiceBank[emotion] || state.voiceBank.feliz;
    const nonRepeated = available.filter((line) => !state.recentVoiceLines.includes(line));
    const pool = nonRepeated.length > 0 ? nonRepeated : available;

    if (!pool.length) {
      return '...';
    }

    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function playVoiceLine(voiceLine, metadata = {}) {
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

    return { dialogue, emotion, tokenCount, delayMs, voiceLine };
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

  function createElement(tagName, className, text) {
    const el = document.createElement(tagName);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function renderVoiceLineList(listContainer) {
    listContainer.innerHTML = '';
    const voiceLines = state.voiceBank[state.selectedEmotion] || [];

    if (!voiceLines.length) {
      listContainer.append(createElement('p', 'stvl-empty', 'Sem voice lines para esta emoção.'));
      return;
    }

    voiceLines.forEach((line, index) => {
      const row = createElement('div', 'stvl-line-row');
      const lineLabel = createElement('span', 'stvl-line-text', line);
      const removeBtn = createElement('button', 'stvl-remove-btn', 'Remover');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        state.voiceBank[state.selectedEmotion].splice(index, 1);
        saveVoiceBank();
        renderVoiceLineList(listContainer);
      });

      row.append(lineLabel, removeBtn);
      listContainer.append(row);
    });
  }

  function buildUi() {
    const root = createElement('section', 'stvl-panel');
    const title = createElement('h2', 'stvl-title', 'ST Voice Lines');

    const tabs = createElement('div', 'stvl-tabs');
    const settingsTabBtn = createElement('button', 'stvl-tab is-active', 'Captioning AI');
    const voiceTabBtn = createElement('button', 'stvl-tab', 'Banco de vozes');
    settingsTabBtn.type = 'button';
    voiceTabBtn.type = 'button';

    const settingsContent = createElement('div', 'stvl-content is-active');
    const voiceContent = createElement('div', 'stvl-content');

    const apiLabel = createElement('label', 'stvl-label', 'API key do Captioning AI');
    const apiInput = createElement('input', 'stvl-input');
    apiInput.type = 'password';
    apiInput.placeholder = 'Cole a API key aqui';
    apiInput.value = state.apiKey;

    const apiHint = createElement('p', 'stvl-hint', 'A chave é salva localmente no navegador.');
    const saveApiButton = createElement('button', 'stvl-primary-btn', 'Salvar API key');
    saveApiButton.type = 'button';
    saveApiButton.addEventListener('click', () => {
      state.apiKey = apiInput.value.trim();
      writeStorage(STORAGE_KEYS.apiKey, state.apiKey);
      saveApiButton.textContent = 'Salvo!';
      setTimeout(() => {
        saveApiButton.textContent = 'Salvar API key';
      }, 1200);
    });

    settingsContent.append(apiLabel, apiInput, saveApiButton, apiHint);

    const emotionLabel = createElement('label', 'stvl-label', 'Emoção');
    const emotionSelect = createElement('select', 'stvl-input');
    Object.keys(state.voiceBank).forEach((emotion) => {
      const option = createElement('option', '', emotion);
      option.value = emotion;
      emotionSelect.append(option);
    });
    emotionSelect.value = state.selectedEmotion;

    const newLineLabel = createElement('label', 'stvl-label', 'Nova voice line');
    const newLineInput = createElement('textarea', 'stvl-input stvl-textarea');
    newLineInput.placeholder = 'Digite uma nova voice line para esta emoção';

    const addLineButton = createElement('button', 'stvl-primary-btn', 'Adicionar voice line');
    addLineButton.type = 'button';

    const listContainer = createElement('div', 'stvl-lines-list');

    emotionSelect.addEventListener('change', () => {
      state.selectedEmotion = emotionSelect.value;
      renderVoiceLineList(listContainer);
    });

    addLineButton.addEventListener('click', () => {
      const value = newLineInput.value.trim();
      if (!value) return;

      const emotion = state.selectedEmotion;
      if (!state.voiceBank[emotion].includes(value)) {
        state.voiceBank[emotion].push(value);
        saveVoiceBank();
      }

      newLineInput.value = '';
      renderVoiceLineList(listContainer);
    });

    voiceContent.append(emotionLabel, emotionSelect, newLineLabel, newLineInput, addLineButton, listContainer);
    renderVoiceLineList(listContainer);

    function activateTab(target) {
      const isSettings = target === 'settings';
      settingsTabBtn.classList.toggle('is-active', isSettings);
      voiceTabBtn.classList.toggle('is-active', !isSettings);
      settingsContent.classList.toggle('is-active', isSettings);
      voiceContent.classList.toggle('is-active', !isSettings);
    }

    settingsTabBtn.addEventListener('click', () => activateTab('settings'));
    voiceTabBtn.addEventListener('click', () => activateTab('voices'));

    tabs.append(settingsTabBtn, voiceTabBtn);
    root.append(title, tabs, settingsContent, voiceContent);
    document.body.append(root);
  }

  function init() {
    loadSettings();
    registerEventBridge();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildUi, { once: true });
    } else {
      buildUi();
    }

    window.STVoiceLines = {
      ...window.STVoiceLines,
      config: {
        historyWindow: HISTORY_WINDOW,
        tokenDelayMs: TOKEN_DELAY_MS,
        minDelayMs: MIN_DELAY_MS,
        maxDelayMs: MAX_DELAY_MS,
      },
      getApiKey: () => state.apiKey,
      setApiKey: (apiKey) => {
        state.apiKey = String(apiKey || '');
        writeStorage(STORAGE_KEYS.apiKey, state.apiKey);
      },
      voiceBank: state.voiceBank,
      processAiReply,
      processDialogue,
      splitDialogues,
      countTokens,
    };

    console.info(`[${EXTENSION_NAME}] initialized.`);
  }

  init();
})();
