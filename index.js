(() => {
  const EXTENSION_NAME = 'st_voice_lines';
  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'gpt-4o-mini',
    prompt:
      'You are a captioning assistant. Pick exactly one emotion from the allowed list that best matches the user dialogue tone. Return only JSON in the form {"emotion":"<allowed_emotion>"}.',
    emotions: ['happy', 'sad', 'angry', 'fearful', 'surprised', 'neutral'],
    enabled: true,
  };

  const state = {
    processing: new Set(),
    initialized: false,
  };

  const getSettingsRoot = () => {
    if (!globalThis.extension_settings) globalThis.extension_settings = {};
    if (!globalThis.extension_settings[EXTENSION_NAME]) {
      globalThis.extension_settings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    return globalThis.extension_settings[EXTENSION_NAME];
  };

  const saveSettings = () => {
    if (typeof globalThis.saveSettingsDebounced === 'function') {
      globalThis.saveSettingsDebounced();
    }
  };

  const getQuotedDialogue = (text) => {
    if (!text || typeof text !== 'string') return '';
    const matches = [...text.matchAll(/["“]([\s\S]*?)["”]/g)]
      .map((m) => m[1]?.trim())
      .filter(Boolean);
    if (!matches.length) return '';
    return matches.join('\n');
  };

  const parseEmotionResponse = (content, allowed) => {
    if (!content) return null;

    try {
      const parsed = JSON.parse(content);
      if (parsed?.emotion && allowed.includes(parsed.emotion)) return parsed.emotion;
    } catch {
      // Fall through to relaxed parsing.
    }

    const lowered = content.toLowerCase();
    return allowed.find((emotion) => lowered.includes(emotion.toLowerCase())) || null;
  };

  const classifyEmotion = async (dialogue) => {
    const settings = getSettingsRoot();
    const emotions = settings.emotions.filter(Boolean);

    if (!settings.apiKey || !emotions.length) return null;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_SETTINGS.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: settings.prompt,
          },
          {
            role: 'user',
            content: `Allowed emotions:\n${emotions.map((e) => `- ${e}`).join('\n')}\n\nDialogue:\n${dialogue}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Captioning AI request failed (${response.status}): ${message}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content?.trim();
    return parseEmotionResponse(content, emotions);
  };

  const renderEmotionBadge = (messageId, emotion) => {
    const mes = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mes) return;

    let container = mes.querySelector('.stvl-caption-emotion');
    if (!container) {
      container = document.createElement('div');
      container.className = 'stvl-caption-emotion';
      const block = mes.querySelector('.mes_block') || mes;
      block.appendChild(container);
    }

    container.textContent = `Caption emotion: ${emotion}`;
  };

  const processMessage = async (messageId) => {
    const key = String(messageId);
    if (state.processing.has(key)) return;

    const settings = getSettingsRoot();
    if (!settings.enabled) return;

    const context = globalThis.getContext?.();
    const message = context?.chat?.[messageId];
    if (!message || message.is_user || message.is_system) return;

    const dialogue = getQuotedDialogue(message.mes);
    if (!dialogue) return;

    message.extra = message.extra || {};
    if (message.extra.stvlCaptionEmotion && message.extra.stvlCaptionSource === dialogue) {
      renderEmotionBadge(messageId, message.extra.stvlCaptionEmotion);
      return;
    }

    state.processing.add(key);

    try {
      const emotion = await classifyEmotion(dialogue);
      if (!emotion) return;

      message.extra.stvlCaptionEmotion = emotion;
      message.extra.stvlCaptionSource = dialogue;
      renderEmotionBadge(messageId, emotion);

      if (typeof globalThis.saveChatDebounced === 'function') {
        globalThis.saveChatDebounced();
      }
    } catch (error) {
      console.warn('[ST Voice Lines] Captioning failed:', error);
    } finally {
      state.processing.delete(key);
    }
  };

  const processLatestAssistantMessage = async () => {
    const context = globalThis.getContext?.();
    if (!context?.chat?.length) return;

    for (let i = context.chat.length - 1; i >= 0; i--) {
      const message = context.chat[i];
      if (!message || message.is_user || message.is_system) continue;
      await processMessage(i);
      break;
    }
  };

  const addEmotion = () => {
    const input = document.getElementById('stvl_new_emotion');
    const value = input?.value?.trim();
    if (!value) return;

    const settings = getSettingsRoot();
    if (!settings.emotions.includes(value)) {
      settings.emotions.push(value);
      renderEmotionList();
      saveSettings();
    }

    input.value = '';
  };

  const removeEmotion = (emotion) => {
    const settings = getSettingsRoot();
    settings.emotions = settings.emotions.filter((item) => item !== emotion);
    renderEmotionList();
    saveSettings();
  };

  const renderEmotionList = () => {
    const list = document.getElementById('stvl_emotions_list');
    if (!list) return;

    list.innerHTML = '';
    const settings = getSettingsRoot();

    settings.emotions.forEach((emotion) => {
      const row = document.createElement('div');
      row.className = 'stvl-emotion-row';

      const name = document.createElement('span');
      name.textContent = emotion;

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'menu_button stvl-remove-emotion';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => removeEmotion(emotion));

      row.append(name, removeButton);
      list.appendChild(row);
    });
  };

  const buildSettingsUi = () => {
    if (document.getElementById('stvl_settings')) return;

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const settings = getSettingsRoot();

    const container = document.createElement('div');
    container.id = 'stvl_settings';
    container.className = 'inline-drawer';
    container.innerHTML = `
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>ST Voice Lines — Captioning AI</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label" for="stvl_enabled">
          <input type="checkbox" id="stvl_enabled" /> Enable captioning
        </label>

        <label for="stvl_api_key">Captioning AI API key</label>
        <input id="stvl_api_key" type="password" class="text_pole" placeholder="sk-..." />

        <label for="stvl_model">Model</label>
        <input id="stvl_model" type="text" class="text_pole" placeholder="gpt-4o-mini" />

        <label for="stvl_prompt">Captioning prompt</label>
        <textarea id="stvl_prompt" class="text_pole" rows="4"></textarea>

        <label>Allowed emotions</label>
        <div id="stvl_emotions_list" class="stvl-emotions-list"></div>

        <div class="stvl-emotion-controls">
          <input id="stvl_new_emotion" type="text" class="text_pole" placeholder="Add emotion" />
          <button id="stvl_add_emotion" type="button" class="menu_button">Add</button>
        </div>
      </div>
    `;

    host.appendChild(container);

    const enabled = document.getElementById('stvl_enabled');
    const apiKey = document.getElementById('stvl_api_key');
    const model = document.getElementById('stvl_model');
    const prompt = document.getElementById('stvl_prompt');

    enabled.checked = settings.enabled;
    apiKey.value = settings.apiKey;
    model.value = settings.model;
    prompt.value = settings.prompt;

    enabled.addEventListener('change', () => {
      settings.enabled = enabled.checked;
      saveSettings();
    });

    apiKey.addEventListener('input', () => {
      settings.apiKey = apiKey.value.trim();
      saveSettings();
    });

    model.addEventListener('input', () => {
      settings.model = model.value.trim();
      saveSettings();
    });

    prompt.addEventListener('input', () => {
      settings.prompt = prompt.value;
      saveSettings();
    });

    document.getElementById('stvl_add_emotion')?.addEventListener('click', addEmotion);
    document.getElementById('stvl_new_emotion')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addEmotion();
      }
    });

    renderEmotionList();
  };

  const bindEvents = () => {
    const source = globalThis.eventSource;
    const types = globalThis.event_types;

    if (!source || !types || typeof source.on !== 'function') return;

    const candidateEvents = [
      types.MESSAGE_RECEIVED,
      types.CHARACTER_MESSAGE_RENDERED,
      types.GENERATION_ENDED,
      types.MESSAGE_SWIPED,
    ].filter(Boolean);

    candidateEvents.forEach((eventType) => {
      source.on(eventType, () => {
        processLatestAssistantMessage();
      });
    });
  };

  const restoreBadgesForVisibleChat = () => {
    const context = globalThis.getContext?.();
    if (!context?.chat) return;

    context.chat.forEach((message, index) => {
      const emotion = message?.extra?.stvlCaptionEmotion;
      if (emotion) {
        renderEmotionBadge(index, emotion);
      }
    });
  };

  const init = () => {
    if (state.initialized) return;
    state.initialized = true;

    getSettingsRoot();
    buildSettingsUi();
    bindEvents();
    restoreBadgesForVisibleChat();
    processLatestAssistantMessage();

    const observer = new MutationObserver(() => {
      buildSettingsUi();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
