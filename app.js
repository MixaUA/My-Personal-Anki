let notebooks = [];
let speechSettings = { noiseThreshold: 20, silenceTimeout: 3, rate: 0.9, pitch: 1.0, voiceURI: '' };

// Safe localStorage wrapper (Android PWA / private mode safe)
function safeGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e) { console.warn('safeGet failed:', key, e); return fallback; }
}
function safeSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch(e) { console.warn('safeSet failed:', key, e); }
}

notebooks = safeGet('scs_v16', []);
speechSettings = safeGet('scs_speech_v4', speechSettings);

let currentIdx = null;
let trainingQueue = [];
let currentCardIdx = 0;
let totalCardsInSession = 0;

// Cached voices for speakText (avoids repeated getVoices() calls on Android)
let availableVoices = [];

// --- AUDIO COMPONENT (SPEECH ENGINE) ---
const SpeechEngine = {
    recognition: null, audioContext: null, analyser: null, stream: null, animationId: null,
    visualData: new Array(150).fill(0),
    audioDataArray: null,
    silenceTimer: null,
    isStreamActive: false,
    isEngineRunning: false,
    isPTTActive: false,
    isRestarting: false,   // Android: prevents overlapping restart attempts
    sessionTranscript: "",

    init() {
        if (this.recognition) return;
        const SpeechReq = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechReq) {
            document.querySelectorAll('.mic-btn').forEach(btn => {
                btn.disabled = true;
                btn.title = "Мікрофон підтримується лише у Chrome / Edge";
            });
            document.querySelectorAll('.speech-input').forEach(i =>
                i.placeholder = "🚫 Додаток не підтримує цю функцію. Використовуйте Chrome або Edge."
            );
            return;
        }

        this.recognition = new SpeechReq();
        this.recognition.lang = 'en-US';
        this.recognition.interimResults = true;
        this.recognition.maxAlternatives = 1;
        this.recognition.continuous = false; // false on all platforms — we manage restart manually

        this.recognition.onresult = (e) => {
            if (!this.isPTTActive) return;

            // Trigger pseudo-wave spike when speech detected (fallback for Android)
            this.pseudoWaveActive = 15;

            let finalText = "";
            let interimText = "";
            for (let i = 0; i < e.results.length; i++) {
                const t = e.results[i][0].transcript.trim();
                if (e.results[i].isFinal) finalText += t + " ";
                else interimText += t;
            }
            if (finalText) this.sessionTranscript += finalText;
            const display = (this.sessionTranscript + interimText).trim();

            document.querySelectorAll('.speech-input').forEach(input => {
                input.value = display;
                input.style.color = '';
            });

            clearTimeout(this.silenceTimer);
            if (display.length > 0) {
                this.silenceTimer = setTimeout(() => {
                    if (this.isPTTActive) this.stopRecording();
                }, speechSettings.silenceTimeout * 1000);
            }
        };

        this.recognition.onstart = () => {
            this.isEngineRunning = true;
            this.isRestarting = false;
            console.log("Recognition: START");

            // Android Variant 3: try AudioContext AFTER recognition has grabbed the mic
            // Small delay gives recognition time to fully acquire hardware
            const isAndroid = /android/i.test(navigator.userAgent);
            if (isAndroid && !this.audioContext) {
                setTimeout(() => this.tryAndroidAudioContext(), 300);
            }
        };

        this.recognition.onend = () => {
            this.isEngineRunning = false;
            console.log("Recognition: END");

            if (this.isPTTActive && this.isStreamActive && !this.isRestarting) {
                this.isRestarting = true;
                setTimeout(() => {
                    this.isRestarting = false;
                    if (this.isPTTActive && !this.isEngineRunning) {
                        try { this.recognition.start(); }
                        catch(e) { console.warn("Restart failed:", e); }
                    }
                }, 250);
            }
        };

        this.recognition.onerror = (e) => {
            this.isEngineRunning = false;
            this.isRestarting = false;
            if (e.error === 'no-speech') return;
            console.warn("Recognition error:", e.error);
            if (this.isPTTActive && (e.error === 'network' || e.error === 'aborted')) {
                setTimeout(() => {
                    if (!this.isEngineRunning && this.isPTTActive) {
                        try { this.recognition.start(); } catch(err) {}
                    }
                }, 500);
            }
        };
    },

    // Wake up AudioContext + mic stream (once per training session)
    async wakeUpHardware() {
        if (this.isStreamActive) return true;

        // Android: getUserMedia conflicts with SpeechRecognition — both cannot share mic
        // Skip AudioContext/visualizer on Android, just mark stream as active
        const isAndroid = /android/i.test(navigator.userAgent);
        if (isAndroid) {
            this.isStreamActive = true;
            this.init();
            return true;
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.audioDataArray = new Uint8Array(this.analyser.frequencyBinCount);
            source.connect(this.analyser);
            this.isStreamActive = true;
            this.init();
            this.draw();
            return true;
        } catch (e) {
            console.error("Microphone error:", e);
            const msg = (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')
                ? "🚫 Дозвіл на мікрофон відхилено. Натисни 🔒 в адресному рядку → Дозволи → Мікрофон"
                : "🚫 Немає доступу до мікрофону";
            document.querySelectorAll('.speech-input').forEach(i => i.placeholder = msg);
            return false;
        }
    },

    // TAP: toggle recording on / off
    async toggleRecording() {
        if (this.isPTTActive) {
            this.stopRecording();
            return;
        }

        // Immediate visual feedback
        this.isPTTActive = true;
        this.isRestarting = false;
        this.sessionTranscript = "";
        clearTimeout(this.silenceTimer);
        document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.add('mic-active'));
        document.querySelectorAll('.speech-input').forEach(i => {
            i.value = "";
            i.placeholder = "Підключення... 🎙️";
        });

        const ok = await this.wakeUpHardware();
        if (!ok) {
            this.isPTTActive = false;
            document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.remove('mic-active'));
            return;
        }

        document.querySelectorAll('.speech-input').forEach(i => i.placeholder = "Слухаю...");

        if (!this.isEngineRunning) {
            try { this.recognition.start(); } catch(e) {}
        }

        // Android: start draw loop immediately for pseudo-wave
        // Real AudioContext attempt happens in onstart after 300ms
        const isAndroid = /android/i.test(navigator.userAgent);
        if (isAndroid && !this.animationId) {
            this.draw();
        }
    },

    stopRecording() {
        if (!this.isPTTActive) return;
        this.isPTTActive = false;
        this.isRestarting = false;
        clearTimeout(this.silenceTimer);
        document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.remove('mic-active'));
        document.querySelectorAll('.speech-input').forEach(i => i.placeholder = "Натисни для запису...");

        // Stop current session; onend will NOT restart because isPTTActive=false
        if (this.isEngineRunning) try { this.recognition.stop(); } catch(e) {}

        // Process answer if in training mode
        const isTraining = document.getElementById('trainingOverlay').style.display === 'flex';
        if (isTraining) {
            const sInput = document.querySelector('.speech-input');
            if (sInput && sInput.value.trim() !== "") checkVoiceAnswer();
        }
    },

    // Android Variant 3: attempt AudioContext after SpeechRecognition has started
    // If it works — real waveform. If not — pseudo-wave fallback kicks in via draw()
    async tryAndroidAudioContext() {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (this.audioContext.state === 'suspended') await this.audioContext.resume();
            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.audioDataArray = new Uint8Array(this.analyser.frequencyBinCount);
            source.connect(this.analyser);
            console.log("Android AudioContext: real waveform active ✓");
            if (!this.animationId) this.draw();
        } catch(e) {
            // Mic conflict — SpeechRecognition holds it, AudioContext can't get in
            // Fallback: pseudo-wave driven by interim results will animate instead
            console.log("Android AudioContext: mic conflict, using pseudo-wave fallback");
            this.audioContext = null;
            this.audioDataArray = null;
            if (!this.animationId) this.draw();
        }
    },

    draw() {
        const canvases = document.querySelectorAll('.audio-canvas');
        if (canvases.length === 0) return;

        if (this.audioDataArray) {
            // Real waveform — AudioContext available
            this.analyser.getByteFrequencyData(this.audioDataArray);
        }

        let maxVol = 0;
        if (this.audioDataArray) {
            // Real audio data
            maxVol = Math.max(...this.audioDataArray);
        } else if (this.isPTTActive && this.isEngineRunning) {
            // Pseudo-wave fallback: animate based on time + speech activity
            // Creates natural-looking oscillation while recording
            const t = Date.now() / 200;
            const base = this.pseudoWaveActive ? 140 : 30;
            maxVol = base + Math.sin(t) * 40 + Math.sin(t * 2.3) * 25 + Math.sin(t * 0.7) * 20;
            // Decay pseudo activity
            if (this.pseudoWaveActive) {
                this.pseudoWaveActive = Math.max(0, (this.pseudoWaveActive || 0) - 1);
            }
        }

        const actualThreshold = 100 + speechSettings.noiseThreshold;

        // Button disabled only at the very first startup moment, not during restarts
        const starting = this.isPTTActive && !this.isEngineRunning && this.isStreamActive && !this.isRestarting;
        document.querySelectorAll('.mic-btn').forEach(btn => btn.disabled = starting);
        document.querySelectorAll('.speech-input').forEach(input => {
            if (!this.isPTTActive) {
                input.placeholder = "Tap to Speak...";
            }
        });

        let displayVal = (maxVol > actualThreshold) ? maxVol : 0;

        this.visualData.push(displayVal);
        this.visualData.shift();

        canvases.forEach(canvas => {
            const ctx = canvas.getContext('2d');
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            if (canvas.width !== rect.width * devicePixelRatio) {
                canvas.width = rect.width * devicePixelRatio;
                canvas.height = rect.height * devicePixelRatio;
                ctx.scale(devicePixelRatio, devicePixelRatio);
            }

            const W = rect.width;
            const H = rect.height;
            ctx.clearRect(0, 0, W, H);

            ctx.beginPath();

            if (this.isStreamActive && !this.isEngineRunning) {
                ctx.strokeStyle = '#e74c3c';
                ctx.setLineDash([2, 4]);
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = this.isPTTActive ? '#1a1a1a' : '#cccccc';
                ctx.lineWidth = this.isPTTActive ? 3 : 1.5;
                ctx.setLineDash([]);
            }

            ctx.lineJoin = 'round';

            for(let i=0; i < this.visualData.length; i++) {
                const x = (W / this.visualData.length) * i;
                const val = this.visualData[i];
                const h = (val / 255) * H;
                const y = (H - h) / 2;

                if(i === 0) ctx.moveTo(x, H / 2);
                else {
                    if (val > 0) ctx.lineTo(x, y + (i % 2 === 0 ? h : 0));
                    else ctx.lineTo(x, H / 2);
                }
            }
            ctx.stroke();

            const thresholdH = (actualThreshold / 255) * H;
            const thresholdYTop = (H - thresholdH) / 2;
            const thresholdYBottom = (H + thresholdH) / 2;
            ctx.beginPath();
            ctx.strokeStyle = '#ff0000';
            ctx.setLineDash([5, 5]);
            ctx.moveTo(0, thresholdYTop); ctx.lineTo(W, thresholdYTop);
            ctx.moveTo(0, thresholdYBottom); ctx.lineTo(W, thresholdYBottom);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        if (this.isStreamActive || this.isPTTActive) {
            this.animationId = requestAnimationFrame(() => this.draw());
        } else {
            this.animationId = null;
        }
    },

    killAll() {
        this.isPTTActive = false;
        this.isRestarting = false;
        if (this.recognition) try { this.recognition.stop(); } catch(e) {}
        this.isStreamActive = false;
        if(this.stream) this.stream.getTracks().forEach(t => t.stop());
        if(this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
    },

    levenshtein(a, b) {
        if (!a || !b) return 99;
        const clean = s => s.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        const s1 = clean(a), s2 = clean(b);
        const m = [];
        for (let i = 0; i <= s1.length; i++) m[i] = [i];
        for (let j = 0; j <= s2.length; j++) m[0][j] = j;
        for (let i = 1; i <= s1.length; i++) {
            for (let j = 1; j <= s2.length; j++) {
                m[i][j] = s1[i-1] === s2[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1], m[i][j-1], m[i-1][j]) + 1;
            }
        }
        return m[s1.length][s2.length];
    }
};

function checkVoiceAnswer() {
    const sInput = document.querySelector('.training-modal .speech-input');
    const input = sInput ? sInput.value : document.querySelector('.speech-input').value;
    const currentCard = trainingQueue[currentCardIdx];
    if(!input || !currentCard) return;

    const correct = currentCard.en || currentCard.code;
    const dist = SpeechEngine.levenshtein(input, correct);
    const limit = Math.floor(correct.length / 5) + 1;

    if (dist <= limit) {
        flipCard();
    } else {
        document.querySelectorAll('.speech-input').forEach(el => {
            el.style.color = '#e74c3c';
            setTimeout(() => { el.style.color = ''; }, 1000);
        });
    }
}

// --- SM-2 LOGIC ---
function startTraining() {
    const nb = notebooks[currentIdx];
    if(!nb.rows || nb.rows.length === 0) return alert("Порожньо!");

    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    document.getElementById('trainingTitle').innerText = nb.name;

    const now = new Date();
    trainingQueue = nb.rows.filter(card => !card.nextReview || new Date(card.nextReview) <= now);

    if(trainingQueue.length === 0) return alert("Все вивчено на сьогодні!");

    totalCardsInSession = trainingQueue.length;
    currentCardIdx = 0;

    updateProgress();
    showCard();
    openModal('trainingOverlay');
}

function updateProgress() {
    const left = trainingQueue.length;
    const elLeft = document.getElementById('cardsLeft');
    const elProg = document.getElementById('progressBar');
    if (elLeft) elLeft.innerText = left;
    if (elProg) {
        const percent = totalCardsInSession > 0 ? ((totalCardsInSession - left) / totalCardsInSession) * 100 : 0;
        elProg.style.width = percent + '%';
    }
}

function gradeCard(quality) {
    const card = trainingQueue[currentCardIdx];
    if (!card) return;

    if (!card.ease) card.ease = 2.5;
    if (!card.reps) card.reps = 0;
    if (!card.interval) card.interval = 0;

    if (quality < 3) { card.reps = 0; card.interval = 0; }
    else if (quality === 3) {
        if (card.reps === 0) card.interval = 1;
        else card.interval = Math.round(card.interval * card.ease);
        card.reps++;
    } else { card.interval = 4; card.reps++; }

    card.ease = Math.max(1.3, card.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

    if (quality === 1) trainingQueue.push(trainingQueue.splice(currentCardIdx, 1)[0]);
    else if (quality === 2) {
        const moved = trainingQueue.splice(currentCardIdx, 1)[0];
        trainingQueue.splice(Math.min(trainingQueue.length, 2), 0, moved);
    }
    else {
        const d = new Date(); d.setDate(d.getDate() + card.interval);
        card.nextReview = d.toISOString();
        trainingQueue.splice(currentCardIdx, 1);
    }

    saveData();
    updateProgress();
    if (trainingQueue.length > 0) {
        if (currentCardIdx >= trainingQueue.length) currentCardIdx = 0;
        showCard();
    } else {
        alert("Чудово! Всі картки засвоєні.");
        closeAllModals();
    }
}

function toggleTheme() { document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; }

function openModal(id) {
    if(id === 'settingsOverlay') syncSettingsUI();
    document.getElementById(id).style.display = 'flex';
}

function closeAllModals() {
    const isTr = document.getElementById('trainingOverlay').style.display === 'flex';
    if (isTr && trainingQueue.length > 0 && !confirm("Вийти?")) return;

    SpeechEngine.killAll();
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    resetCard();
}

let _ttsTimeout = null;
function updateSpeechSetting(key, val) {
    speechSettings[key] = parseFloat(val);

    const map = {'rate':'valRate', 'pitch':'valPitch', 'noiseThreshold':'valNoise', 'silenceTimeout':'valTimeout'};
    const el = document.getElementById(map[key]);
    if (el) el.innerText = val;
    safeSet('scs_speech_v4', speechSettings);

    if (key === 'rate' || key === 'pitch') {
        clearTimeout(_ttsTimeout);
        _ttsTimeout = setTimeout(() => { speakText("Voice test"); }, 300);
    }
}

function updateVoice(uri) {
    speechSettings.voiceURI = uri;
    safeSet('scs_speech_v4', speechSettings);
    speakText("Voice test");
}

function populateVoices() {
    // Cache globally — avoids repeated getVoices() calls on Android
    availableVoices = speechSynthesis.getVoices();
    const select = document.getElementById('voiceSelect');
    if (!select) return;

    select.innerHTML = '<option value="">Відпустити на розсуд системи</option>';
    availableVoices
        .filter(v => /^en[_-]/i.test(v.lang))
        .forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.voiceURI;
            opt.textContent = `${v.name} (${v.lang})`;
            select.appendChild(opt);
        });
}

function syncSettingsUI() {
    const select = document.getElementById('voiceSelect');
    if (select) select.value = speechSettings.voiceURI || '';

    const map = {
        'inputRate': 'rate', 'valRate': 'rate',
        'inputPitch': 'pitch', 'valPitch': 'pitch',
        'inputNoise': 'noiseThreshold', 'valNoise': 'noiseThreshold',
        'inputTimeout': 'silenceTimeout', 'valTimeout': 'silenceTimeout'
    };
    for (let id in map) {
        const el = document.getElementById(id);
        if (el) {
            const val = speechSettings[map[id]];
            if (el.tagName === 'INPUT') el.value = val; else el.innerText = val;
        }
    }
}

function speakText(text) {
    if (!text) return;
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    let voice = null;

    if (speechSettings.voiceURI) {
        voice = voices.find(v => v.voiceURI === speechSettings.voiceURI) || null;
    }
    if (!voice) {
        // Android uses en_GB / en_US (underscore), desktop uses en-GB / en-US (dash)
        voice = voices.find(v => /^en[_-]/i.test(v.lang)) || null;
    }

    if (voice) utterance.voice = voice;
    utterance.lang = 'en-US';
    utterance.rate = speechSettings.rate;
    utterance.pitch = speechSettings.pitch;
    speechSynthesis.speak(utterance);
}

function speakCurrentCard() {
    const card = trainingQueue[currentCardIdx];
    if (card) speakText(card.en || card.code || "");
}

function showCard() {
    resetCard();
    const card = trainingQueue[currentCardIdx];
    if (!card) return;
    document.getElementById('cardCode').innerText = card.code || "";
    document.getElementById('cardUA').innerText = card.ua || "";
    document.getElementById('cardEN').innerText = card.en || "";
    document.getElementById('cardTrans').innerText = card.trans ? `[${card.trans}]` : "";
    document.querySelectorAll('.speech-input').forEach(i => i.value = "");
    document.getElementById('speechPanel').style.display = 'flex';
}

function flipCard() {
    const card = document.getElementById('mainCard');
    if(!card.classList.contains('flipped')) {
        card.classList.add('flipped');
        document.getElementById('trainingActions').style.display = 'block';
        document.getElementById('speechPanel').style.display = 'none';
        document.getElementById('hintText').style.display = 'none';
        // Android: speak() must be called within user gesture call stack
        // setTimeout(250) breaks this chain and causes not-allowed error
        speakCurrentCard();
    }
}

function resetCard() {
    const card = document.getElementById('mainCard');
    if (card) card.classList.remove('flipped');
    const act = document.getElementById('trainingActions');
    if (act) act.style.display = 'none';
    const hint = document.getElementById('hintText');
    if (hint) hint.style.display = 'block';
}

function openAdmin(idx = null) {
    if(idx !== null) currentIdx = idx;
    const container = document.getElementById('adminCardsContainer');
    if (!container) return;
    container.innerHTML = '';
    notebooks[currentIdx].rows.forEach((row, index) => insertCardRow(row, index + 1));
    openModal('adminOverlay');
}

function insertCardRow(data = {ua:'', code:'', en:'', trans:''}, num = null) {
    const container = document.getElementById('adminCardsContainer');
    const n = num || container.children.length + 1;
    const card = document.createElement('div');
    card.className = 'admin-card';
    card.innerHTML = `<div class="card-header"><span class="card-num">#${n}</span><button onclick="this.closest('.admin-card').remove(); app.reindex();">🗑️</button></div>
        <input type="text" class="admin-input v-ua" placeholder="UA" value="${data.ua}">
        <input type="text" class="admin-input v-code" placeholder="Code" value="${data.code}">
        <input type="text" class="admin-input v-en" placeholder="EN" value="${data.en}">
        <input type="text" class="admin-input v-trans" placeholder="Trans" value="${data.trans}">`;
    container.appendChild(card);
}

function reindex() { document.querySelectorAll('.card-num').forEach((s, i) => s.innerText = `#${i+1}`); }

function saveAdminData() {
    notebooks[currentIdx].rows = Array.from(document.querySelectorAll('.admin-card')).map(c => ({
        ua: c.querySelector('.v-ua').value, code: c.querySelector('.v-code').value,
        en: c.querySelector('.v-en').value, trans: c.querySelector('.v-trans').value
    }));
    saveData(); alert("Збережено!");
}

function addNotebook(isL) {
    const val = prompt("Назва:");
    if(val) { notebooks.push({ name: val, linked: true, rows: [] }); saveData(); closeAllModals(); }
}

function addNotebookWithFile(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        notebooks.push({ name: file.name.replace('.json',''), linked: true, rows: JSON.parse(ev.target.result) });
        saveData();
        closeAllModals();
    }; reader.readAsText(file);
    e.target.value = '';
}

function updateFromFile(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        notebooks[currentIdx].name = file.name.replace('.json','');
        notebooks[currentIdx].rows = JSON.parse(ev.target.result);
        saveData();
        alert("Оновлено!");
        closeAllModals();
    };
    reader.readAsText(file);
    e.target.value = '';
}

function exportCurrentNotebook() {
    const b = new Blob([JSON.stringify(notebooks[currentIdx].rows, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${notebooks[currentIdx].name}.json`; a.click();
}

function deleteCurrentNotebook() { if(confirm("Видалити?")) { notebooks.splice(currentIdx, 1); saveData(); closeAllModals(); } }
function saveData() { safeSet('scs_v16', notebooks); renderShelf(); }

function renderShelf() {
    const shelf = document.getElementById('shelf');
    if (!shelf) return;
    shelf.innerHTML = `<div class="notebook hand-drawn-border" onclick="openModal('createOverlay')"><div class="notebook-cover" style="font-size:3rem; color:var(--accent)">+</div></div>`;
    notebooks.forEach((nb, i) => {
        const div = document.createElement('div');
        div.className = 'notebook hand-drawn-border';
        div.onclick = () => { currentIdx = i; document.getElementById('menuTitle').innerText = nb.name; document.getElementById('syncBtn').style.display = 'block'; openModal('menuOverlay'); };
        div.innerHTML = `<div class="notebook-cover">${nb.name}</div>`;
        shelf.appendChild(div);
    });
}

// TAP-TO-TALK binding
function initPTT() {
    document.querySelectorAll('.mic-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            SpeechEngine.toggleRecording();
        };
    });
}

function applyUpdate() {
    if (window.newWorker) {
        window.newWorker.postMessage({ action: 'skipWaiting' });
    }
}

window.app = {
    checkVoiceAnswer, updateSpeechSetting, updateVoice, toggleTheme, openModal, closeAllModals,
    openAdmin, insertCardRow, saveAdminData, addNotebook, addNotebookWithFile, updateFromFile,
    exportCurrentNotebook, deleteCurrentNotebook, reindex, applyUpdate
};

// Voices: onvoiceschanged fires on desktop; on Android call immediately + on event
// setTimeout(1000) is a fallback for Android versions where onvoiceschanged never fires
speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();
setTimeout(populateVoices, 1000);

// Init recognition engine immediately so it's ready before first mic tap
SpeechEngine.init();

renderShelf();
initPTT();

// Auto-update footer year
const yearEl = document.getElementById('currentYear');
if (yearEl) yearEl.innerText = new Date().getFullYear();

// Browser speech support check
if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    document.body.classList.add('no-speech');
    const voicePanel = document.getElementById('voiceSettingsContent');
    if (voicePanel) {
        voicePanel.innerHTML = `
            <div style="text-align:center; padding: 20px 10px; line-height: 1.9; font-size: 1rem;">
                <p>Голосовий ввід підтримується лише у браузерах на основі <strong>Chromium</strong>:</p>
                <p style="margin-top:10px;">🌐 Chrome &nbsp;&nbsp; 🔵 Edge &nbsp;&nbsp; ⚡ Brave &nbsp;&nbsp; 🟠 Opera &nbsp;&nbsp; 🟣 Vivaldi</p>
            </div>`;
    }
}

// Service Worker registration & update detection
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').then(reg => {
            reg.addEventListener('updatefound', () => {
                window.newWorker = reg.installing;
                window.newWorker.addEventListener('statechange', () => {
                    if (window.newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        document.getElementById('updateBanner').style.display = 'block';
                    }
                });
            });
        });

        let refreshing;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });
    });
}

// ============================================================
// ANDROID ДІАГНОСТИКА — ТИМЧАСОВИЙ БЛОК
// Коли все запрацює — видалити від цього рядка до кінця файлу
// ============================================================
(function() {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 99999;
        border-top: 2px solid #00ff88; font-family: monospace; font-size: 11px;
    `;
    document.body.appendChild(wrapper);

    const toolbar = document.createElement('div');
    toolbar.style.cssText = `
        display: flex; align-items: center; gap: 6px;
        background: #111; padding: 4px 8px;
    `;
    wrapper.appendChild(toolbar);

    const title = document.createElement('span');
    title.textContent = '🐛 Android Debug';
    title.style.cssText = 'color:#00ff88; flex:1; font-weight:bold;';
    toolbar.appendChild(title);

    const btnStyle = 'background:#333;color:#fff;border:1px solid #555;padding:2px 10px;font-size:11px;cursor:pointer;border-radius:3px;';

    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '▼ згорнути';
    collapseBtn.style.cssText = btnStyle;
    toolbar.appendChild(collapseBtn);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 копіювати';
    copyBtn.style.cssText = btnStyle;
    toolbar.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = btnStyle + 'color:#ff6666;';
    toolbar.appendChild(closeBtn);

    const log = document.createElement('div');
    log.id = 'androidDebug';
    log.style.cssText = `
        background: rgba(0,0,0,0.92); color: #00ff88;
        padding: 6px 8px; max-height: 40vh; overflow-y: auto;
    `;
    wrapper.appendChild(log);

    let collapsed = false;
    collapseBtn.onclick = () => {
        collapsed = !collapsed;
        log.style.display = collapsed ? 'none' : 'block';
        collapseBtn.textContent = collapsed ? '▲ розгорнути' : '▼ згорнути';
    };

    copyBtn.onclick = () => {
        const lines = Array.from(log.querySelectorAll('div'))
            .map(el => el.textContent).join('\n');
        navigator.clipboard.writeText(lines).then(() => {
            copyBtn.textContent = '✓ скопійовано!';
            setTimeout(() => { copyBtn.textContent = '📋 копіювати'; }, 2000);
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = lines;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            copyBtn.textContent = '✓ скопійовано!';
            setTimeout(() => { copyBtn.textContent = '📋 копіювати'; }, 2000);
        });
    };

    closeBtn.onclick = () => wrapper.remove();

    function dbg(msg, color) {
        const line = document.createElement('div');
        line.style.color = color || '#00ff88';
        line.textContent = '[' + new Date().toISOString().slice(11,19) + '] ' + msg;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
        console.log('[DBG]', msg);
    }

    // --- 1. Базова підтримка API ---
    dbg('=== ДІАГНОСТИКА СТАРТ ===', '#ffff00');
    dbg('SpeechRecognition: ' + !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        (window.SpeechRecognition || window.webkitSpeechRecognition) ? '#00ff88' : '#ff4444');
    dbg('speechSynthesis: ' + !!window.speechSynthesis,
        window.speechSynthesis ? '#00ff88' : '#ff4444');
    dbg('getUserMedia: ' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? '#00ff88' : '#ff4444');
    dbg('AudioContext: ' + !!(window.AudioContext || window.webkitAudioContext),
        (window.AudioContext || window.webkitAudioContext) ? '#00ff88' : '#ff4444');
    dbg('Protocol: ' + location.protocol, location.protocol === 'https:' ? '#00ff88' : '#ff4444');
    dbg('UserAgent: ' + navigator.userAgent.slice(0, 80), '#aaaaaa');

    // --- 2. Голоси TTS — показуємо точні lang коди ---
    function checkVoices() {
        const voices = speechSynthesis.getVoices();
        dbg('Voices total: ' + voices.length, voices.length > 0 ? '#00ff88' : '#ff9900');
        voices.forEach(v => dbg('  voice: "' + v.name + '" lang="' + v.lang + '" uri="' + v.voiceURI + '"', '#aaffff'));
    }
    checkVoices();
    speechSynthesis.onvoiceschanged = () => { dbg('onvoiceschanged fired!', '#ffff00'); checkVoices(); };
    setTimeout(() => { dbg('--- voices @1s ---', '#888888'); checkVoices(); }, 1000);
    setTimeout(() => { dbg('--- voices @3s ---', '#888888'); checkVoices(); }, 3000);

    // --- 3. Тест TTS без примусового голосу ---
    setTimeout(() => {
        dbg('Спроба TTS без voice...', '#ffff00');
        try {
            const u = new SpeechSynthesisUtterance('test');
            u.lang = 'en-US';
            u.onstart = () => dbg('TTS: onstart ✓', '#00ff88');
            u.onend   = () => dbg('TTS: onend ✓', '#00ff88');
            u.onerror = (e) => dbg('TTS ERROR: ' + e.error, '#ff4444');
            speechSynthesis.speak(u);
        } catch(e) {
            dbg('TTS exception: ' + e.message, '#ff4444');
        }
    }, 1500);

    // --- 3b. ІЗОЛЬОВАНИЙ тест SpeechRecognition — БЕЗ getUserMedia ---
    // Якщо цей тест розпізнає слова → проблема в конфлікті мікрофону з AudioContext
    // Якщо не розпізнає → проблема глибша (permissions, network, etc.)
    const SpeechReq = window.SpeechRecognition || window.webkitSpeechRecognition;
    const testRec = new SpeechReq();
    testRec.lang = 'en-US';
    testRec.continuous = false;
    testRec.interimResults = true;

    const testBtn = document.createElement('button');
    testBtn.textContent = '🎤 ТЕСТ МІК (без AudioContext)';
    testBtn.style.cssText = 'display:block;width:100%;margin:4px 0;padding:6px;background:#1a4a1a;color:#00ff88;border:1px solid #00ff88;font-size:12px;cursor:pointer;';
    log.appendChild(testBtn);

    let testActive = false;
    testRec.onstart  = () => dbg('TEST-REC: onstart ✓ — говори англійською!', '#00ff88');
    testRec.onend    = () => { dbg('TEST-REC: onend', '#ff9900'); testActive = false; testBtn.textContent = '🎤 ТЕСТ МІК (без AudioContext)'; };
    testRec.onerror  = (e) => dbg('TEST-REC ERROR: ' + e.error, '#ff4444');
    testRec.onresult = (e) => {
        const t = e.results[0][0].transcript;
        dbg('TEST-REC 📝 РОЗПІЗНАНО: "' + t + '"', '#00ffff');
    };

    testBtn.onclick = () => {
        if (testActive) { testRec.stop(); return; }
        testActive = true;
        testBtn.textContent = '⏹ зупинити тест';
        dbg('--- Запуск ізольованого тесту мікрофону ---', '#ffff00');
        try { testRec.start(); } catch(e) { dbg('TEST-REC start error: ' + e.message, '#ff4444'); }
    };

    // --- 4. Патч toggleRecording ---
    const origToggle = SpeechEngine.toggleRecording.bind(SpeechEngine);
    SpeechEngine.toggleRecording = async function() {
        dbg('toggleRecording() викликано', '#ffff00');
        dbg('  isPTTActive: ' + this.isPTTActive, '#aaaaaa');
        dbg('  isStreamActive: ' + this.isStreamActive, '#aaaaaa');
        dbg('  isEngineRunning: ' + this.isEngineRunning, '#aaaaaa');
        await origToggle();
        setTimeout(() => {
            dbg('  → isPTTActive: ' + this.isPTTActive, '#aaaaaa');
            dbg('  → isStreamActive: ' + this.isStreamActive, '#aaaaaa');
            dbg('  → isEngineRunning: ' + this.isEngineRunning, '#aaaaaa');
        }, 800);
    };

    // --- 5. Патч recognition подій (через 600ms — після SpeechEngine.init()) ---
    setTimeout(() => {
        if (SpeechEngine.recognition) {
            const r = SpeechEngine.recognition;
            const origStart  = r.onstart;
            const origEnd    = r.onend;
            const origError  = r.onerror;
            const origResult = r.onresult;
            r.onstart  = (e) => { dbg('🎙 recognition.onstart', '#00ff88');          if(origStart)  origStart.call(SpeechEngine, e);  };
            r.onend    = (e) => { dbg('🔴 recognition.onend', '#ff9900');             if(origEnd)    origEnd.call(SpeechEngine, e);    };
            r.onerror  = (e) => { dbg('❌ recognition.error: ' + e.error, '#ff4444'); if(origError)  origError.call(SpeechEngine, e);  };
            r.onresult = (e) => { dbg('📝 ' + e.results[0][0].transcript, '#00ffff'); if(origResult) origResult.call(SpeechEngine, e); };
            dbg('Recognition handlers патчено ✓', '#00ff88');
        } else {
            dbg('recognition == null після 600ms!', '#ff4444');
        }
    }, 600);

    dbg('Готово. Натисни мікрофон.', '#ffff00');
})();
// ============================================================
// КІНЕЦЬ ДІАГНОСТИЧНОГО БЛОКУ
// ============================================================
