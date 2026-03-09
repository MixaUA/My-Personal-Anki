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
    pseudoWaveActive: 0,
    sessionTranscript: "",

    isSupported() {
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },

    _createRecognition() {
        const SpeechReq = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SpeechReq();
        rec.lang = 'en-US';
        rec.continuous = false;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onstart = () => {
            this.isEngineRunning = true;
            console.log('Recognition: START');
        };

        rec.onresult = (e) => {
            if (!this.isPTTActive) return;
            this.pseudoWaveActive = 15;
            let finalText = '', interimText = '';
            for (let i = 0; i < e.results.length; i++) {
                const t = e.results[i][0].transcript.trim();
                if (e.results[i].isFinal) finalText += t + ' ';
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

        rec.onend = () => {
            this.isEngineRunning = false;
            console.log('Recognition: END');
            if (this.isPTTActive) {
                setTimeout(() => {
                    if (this.isPTTActive && !this.isEngineRunning) {
                        this.recognition = this._createRecognition();
                        try { this.recognition.start(); } catch(e) { console.warn('Restart failed:', e); }
                    }
                }, 250);
            }
        };

        rec.onerror = (e) => {
            this.isEngineRunning = false;
            if (e.error === 'no-speech') return;
            console.warn('Recognition error:', e.error);
            if (this.isPTTActive && (e.error === 'network' || e.error === 'aborted')) {
                setTimeout(() => {
                    if (this.isPTTActive && !this.isEngineRunning) {
                        this.recognition = this._createRecognition();
                        try { this.recognition.start(); } catch(err) {}
                    }
                }, 500);
            }
        };

        return rec;
    },

    async _startVisualizer() {
        if (this.isStreamActive) return;
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (this.audioContext.state === 'suspended') await this.audioContext.resume();
            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.audioDataArray = new Uint8Array(this.analyser.frequencyBinCount);
            source.connect(this.analyser);
            this.isStreamActive = true;
            this.draw();
        } catch(e) {
            console.warn('Visualizer error:', e);
            const msg = (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')
                ? '🚫 Дозвіл на мікрофон відхилено. Натисни 🔒 → Дозволи → Мікрофон'
                : '🚫 Немає доступу до мікрофону';
            document.querySelectorAll('.speech-input').forEach(i => i.placeholder = msg);
        }
    },

    async toggleRecording() {
        if (this.isPTTActive) {
            this.stopRecording();
            return;
        }
        if (!this.isSupported()) return;
        this.isPTTActive = true;
        this.sessionTranscript = '';
        clearTimeout(this.silenceTimer);
        document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.add('mic-active'));
        document.querySelectorAll('.speech-input').forEach(i => {
            i.value = '';
            i.placeholder = 'Слухаю...';
        });

        const isAndroid = /android/i.test(navigator.userAgent);
        if (!isAndroid) {
            await this._startVisualizer();
        } else {
            this.isStreamActive = true;
            if (!this.animationId) this.draw();
        }

        this.recognition = this._createRecognition();
        try {
            this.recognition.start();
        } catch(e) {
            console.warn('Recognition start failed:', e);
            this.isPTTActive = false;
            document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.remove('mic-active'));
        }
    },

    stopRecording() {
        if (!this.isPTTActive) return;
        this.isPTTActive = false;
        clearTimeout(this.silenceTimer);
        document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.remove('mic-active'));
        document.querySelectorAll('.speech-input').forEach(i => i.placeholder = 'Натисни для запису...');

        if (this.isEngineRunning) try { this.recognition.stop(); } catch(e) {}

        const isTraining = document.getElementById('trainingOverlay').style.display === 'flex';
        if (isTraining) {
            const sInput = document.querySelector('.speech-input');
            if (sInput && sInput.value.trim() !== '') checkVoiceAnswer();
        }
    },

    draw() {
        const canvases = document.querySelectorAll('.audio-canvas');
        if (canvases.length === 0) return;
        if (this.audioDataArray) {
            this.analyser.getByteFrequencyData(this.audioDataArray);
        }

        let maxVol = 0;
        if (this.audioDataArray) {
            maxVol = Math.max(...this.audioDataArray);
        } else if (this.isPTTActive && this.isEngineRunning) {
            const t = Date.now() / 200;
            const base = this.pseudoWaveActive > 0 ? 140 : 30;
            maxVol = base + Math.sin(t) * 40 + Math.sin(t * 2.3) * 25 + Math.sin(t * 0.7) * 20;
            if (this.pseudoWaveActive > 0) this.pseudoWaveActive--;
        }

        const actualThreshold = 100 + speechSettings.noiseThreshold;
        const displayVal = (maxVol > actualThreshold) ? maxVol : 0;
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
            const W = rect.width, H = rect.height;
            ctx.clearRect(0, 0, W, H);
            ctx.beginPath();
            if (this.isStreamActive && !this.isEngineRunning) {
                ctx.strokeStyle = '#e74c3c'; ctx.setLineDash([2, 4]); ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = this.isPTTActive ? '#1a1a1a' : '#cccccc';
                ctx.lineWidth = this.isPTTActive ? 3 : 1.5;
                ctx.setLineDash([]);
            }
            ctx.lineJoin = 'round';
            for (let i = 0; i < this.visualData.length; i++) {
                const x = (W / this.visualData.length) * i;
                const val = this.visualData[i];
                const h = (val / 255) * H;
                const y = (H - h) / 2;
                if (i === 0) ctx.moveTo(x, H / 2);
                else {
                    if (val > 0) ctx.lineTo(x, y + (i % 2 === 0 ? h : 0));
                    else ctx.lineTo(x, H / 2);
                }
            }
            ctx.stroke();
        });

        if (this.isStreamActive || this.isPTTActive) {
            this.animationId = requestAnimationFrame(() => this.draw());
        } else {
            this.animationId = null;
        }
    },

    killAll() {
        this.isPTTActive = false;
        if (this.recognition) try { this.recognition.stop(); } catch(e) {}
        this.isStreamActive = false;
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        if (this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
    },

    levenshtein(a, b) {
        if (!a || !b) return 99;
        const clean = s => s.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '');
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
            setTimeout(() => { 
                el.style.color = ''; 
                el.value = 'Спробуй ще!';
                setTimeout(() => {
                    if (el.value === 'Спробуй ще!') el.value = '';
                }, 1200);
            }, 800);
        });
    }
}

// --- CUSTOM DIALOG ENGINE ---
let dialogResolve = null;
function showDialog({ message, type = 'alert', placeholder = '' }) {
    return new Promise((resolve) => {
        dialogResolve = resolve;
        const overlay = document.getElementById('dialogOverlay');
        const msgEl = document.getElementById('dialogMessage');
        const inputEl = document.getElementById('dialogInput');
        const cancelBtn = document.getElementById('dialogCancel');
        
        msgEl.innerText = message;
        inputEl.style.display = type === 'prompt' ? 'block' : 'none';
        inputEl.value = '';
        inputEl.placeholder = placeholder;
        cancelBtn.style.display = type === 'alert' ? 'none' : 'block';
        
        overlay.style.display = 'flex';
        if (type === 'prompt') setTimeout(() => inputEl.focus(), 100);
    });
}
function handleDialog(success) {
    const overlay = document.getElementById('dialogOverlay');
    const inputEl = document.getElementById('dialogInput');
    overlay.style.display = 'none';
    if (dialogResolve) {
        if (inputEl.style.display === 'block') {
            dialogResolve(success ? inputEl.value : null);
        } else {
            dialogResolve(success);
        }
    }
}

// --- SM-2 LOGIC ---
async function startTraining() {
    const nb = notebooks[currentIdx];
    if(!nb.rows || nb.rows.length === 0) return showDialog({ message: "Порожньо!" });

    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    document.getElementById('trainingTitle').innerText = nb.name;

    const now = new Date();
    trainingQueue = nb.rows.filter(card => !card.nextReview || new Date(card.nextReview) <= now);

    if(trainingQueue.length === 0) return showDialog({ message: "Все вивчено на сьогодні!" });

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
        showDialog({ message: "Чудово! Всі картки засвоєні." });
        closeAllModals();
    }
}

function toggleTheme() { 
    const isDark = document.body.dataset.theme === 'dark';
    document.body.dataset.theme = isDark ? 'light' : 'dark';
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) {
        themeBtn.innerHTML = isDark 
            ? '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' // Moon
            : '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1V3M12 21V23M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'; // Sun
    }
}

function openModal(id) {
    if(id === 'settingsOverlay') syncSettingsUI();
    document.getElementById(id).style.display = 'flex';
}

async function closeAllModals() {
    const isTr = document.getElementById('trainingOverlay').style.display === 'flex';
    if (isTr && trainingQueue.length > 0 && !(await showDialog({ message: "Вийти?", type: 'confirm' }))) return;

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
        speakCurrentCard();
    }
}

function resetCard() {
    const card = document.getElementById('mainCard');
    if (card) card.classList.remove('flipped');
    const act = document.getElementById('trainingActions');
    if (act) act.style.display = 'none';
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
    saveData(); showDialog({ message: "Збережено!" });
}

async function addNotebook(isL) {
    const val = await showDialog({ message: "Назва:", type: 'prompt' });
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
        showDialog({ message: "Оновлено!" });
        closeAllModals();
    };
    reader.readAsText(file);
    e.target.value = '';
}

function exportCurrentNotebook() {
    const b = new Blob([JSON.stringify(notebooks[currentIdx].rows, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${notebooks[currentIdx].name}.json`; a.click();
}

async function deleteCurrentNotebook() { if(await showDialog({ message: "Видалити?", type: 'confirm' })) { notebooks.splice(currentIdx, 1); saveData(); closeAllModals(); } }
function saveData() { safeSet('scs_v16', notebooks); renderShelf(); }

function renderShelf() {
    const shelf = document.getElementById('shelf');
    if (!shelf) return;
    shelf.innerHTML = '';
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
    exportCurrentNotebook, deleteCurrentNotebook, reindex, applyUpdate, handleDialog
};

// Voices: onvoiceschanged fires on desktop; on Android call immediately + on event
// setTimeout(1000) is a fallback for Android versions where onvoiceschanged never fires
speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();
setTimeout(populateVoices, 1000);

renderShelf();
initPTT();

// Auto-update footer year
const yearEl = document.getElementById('currentYear');
if (yearEl) yearEl.innerText = new Date().getFullYear();

// Scroll listener for sticky header "scrolled" state
window.addEventListener('scroll', () => {
    if (window.scrollY > 10) {
        document.body.classList.add('scrolled');
    } else {
        document.body.classList.remove('scrolled');
    }
});

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
            const showUpdateBanner = (worker) => {
                window.newWorker = worker;
                document.getElementById('updateBanner').style.display = 'block';
            };

            // 1. Check if there's already an update waiting (persists across refreshes)
            if (reg.waiting) showUpdateBanner(reg.waiting);

            // 2. Check if an update is installing
            if (reg.installing) {
                reg.installing.addEventListener('statechange', () => {
                    if (reg.installing.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdateBanner(reg.installing);
                    }
                });
            }

            // 3. Listen for future update findings
            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdateBanner(newWorker);
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
