/**
 * CAPYMAGE — capybara.js
 * Features: Combo System, Screen Shake, Pause/Resume,
 *           Harder spawn rates, Supabase-ready score export
 *
 * Keyboard: A="-"  W="|"  S="v"  D="^"  (Arrow keys also work)
 * IoT Glove: WebSocket ws://192.168.4.1:81
 */

// ─── CANVAS ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');
canvas.width  = 1280;
canvas.height = 720;
ctx.imageSmoothingEnabled = false;

const CW = canvas.width;
const CH = canvas.height;

// ─── TUNING ───────────────────────────────────────────────────────────────────
const CFG = {
    // ── Spawn ──
    SPAWN_INTERVAL_MS : 700,     // was 1200 — more aggressive spawning
    PHASE_JEDA_MS     : 1400,    // was 2000 — shorter phase gap

    // ── Combat ──
    AOE_RADIUS        : 520,
    KNOCKBACK_X       : 55,
    KNOCKBACK_Y       : 30,

    // ── Enemy speed (was 0.9 / 1.7) ──
    SPEED_MIN         : 1.4,
    SPEED_MAX         : 2.6,

    // ── Screen shake ──
    SHAKE_DAMAGE_MAG  : 10,
    SHAKE_KILL_MAG    : 5,
    SHAKE_DECAY       : 0.85,

    // ── Combo ──
    COMBO_WINDOW_MS   : 1800,   // time to chain another kill for combo
};

// ─── SPRITE CONFIG ────────────────────────────────────────────────────────────
const SPRITE_DATA = {
    capy: {
        scale: 2,
        frames: { idle:6, run:8, hit:4, death:7, atk1:8, atk2:8, atk3:8, atk4:8 },
        speed:  { idle:100, run:80, hit:80, death:120, atk1:70, atk2:70, atk3:70, atk4:70 },
        offsetX:{ idle:0, run:0, hit:0, death:0, atk1:0, atk2:0, atk3:0, atk4:0 }
    },
    slime: {
        fw:32, fh:25, scale:3,
        defaultFacing:'left',
        rows:  { walk:0, atk:1, die:2, hurt:0 },
        frames:{ walk:8, atk:8, die:5, hurt:4 },
        speed: { walk:120, atk:120, die:130, hurt:100 },
        runeOffsetY: -20
    },
    skeleton: {
        fw:96, fh:64, scale:2.5,
        defaultFacing:'right',
        frames:{ walk:10, atk:10, die:13, hurt:5 },
        speed: { walk:100, atk:100, die:110, hurt:90 },
        runeOffsetY: -40
    },
    golem: {
        fw:150, fh:150, scale:3.5,
        defaultFacing:'right',
        frames:{ walk:10, atk:11, die:12, hurt:4 },
        speed: { walk:110, atk:90, die:120, hurt:100 },
        runeOffsetY: 120
    }
};

// ─── LEVEL DESIGN (harder counts) ─────────────────────────────────────────────
const LEVEL_PHASES = {
    1: [ {type:'slime', count:14} ],
    2: [ {type:'slime', count:10}, {type:'skeleton', count:8} ],
    3: [ {type:'slime', count:8},  {type:'skeleton', count:8}, {type:'golem', count:6} ]
};

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
let isPlaying    = false;
let screenShakeTimer = 0;
let currentLevel = 1;
let score        = 0;
let playerHp     = 3;
let _prevHp      = 3;
let enemies      = [];
let lastTime     = 0;
let levelState   = 'PLAYING';
let animFrameId  = null;

let spawnQueue       = [];
let spawnTimer       = 0;
let phaseJedaTimer   = 0;
let waitingNextPhase = false;
let levelCleared     = false;

let fadeAlpha    = 1;
let fadeDir      = 0;
let fadeSpeed    = 0.03;
let fadeCallback = null;

let levelTitleText  = '';
let levelTitleAlpha = 0;

// ─── SCREEN SHAKE ─────────────────────────────────────────────────────────────
let shakeMag = 0;
let shakeX   = 0;
let shakeY   = 0;

function triggerShake(mag) {
    shakeMag = Math.max(shakeMag, mag);
}

function tickShake() {
    if (shakeMag < 0.3) { shakeMag = 0; shakeX = 0; shakeY = 0; return; }
    shakeX   = (Math.random() * 2 - 1) * shakeMag;
    shakeY   = (Math.random() * 2 - 1) * shakeMag;
    shakeMag *= CFG.SHAKE_DECAY;
}

// ─── COMBO SYSTEM ─────────────────────────────────────────────────────────────
let comboCount    = 0;
let comboTimer    = 0;
let comboMulti    = 1;
let comboPopups   = [];   // {text, x, y, alpha, vy, color}

const COMBO_LABELS = {
    2: { text: 'DOUBLE KILL!',  color: '#fbbf24' },
    3: { text: 'TRIPLE KILL!',  color: '#f97316' },
    4: { text: 'QUAD KILL!',    color: '#ef4444' },
    5: { text: 'PENTA KILL!',   color: '#a855f7' },
};

function registerKill(count) {
    // count = how many enemies died from this single gesture sweep
    comboCount += count;
    comboTimer  = CFG.COMBO_WINDOW_MS;

    if (count >= 2) {
        const label = COMBO_LABELS[Math.min(count, 5)] ?? { text: `×${count} COMBO!`, color: '#ec4899' };
        spawnComboPopup(label.text, label.color);
        triggerShake(CFG.SHAKE_KILL_MAG * count);
    } else {
        triggerShake(CFG.SHAKE_KILL_MAG);
    }

    // Score multiplier: x1 = normal, x2 if ≥3 hit together
    comboMulti = count >= 3 ? 2 : 1;
    updateComboHUD();
}

function tickCombo(dt) {
    if (comboTimer > 0) {
        comboTimer -= dt;
        if (comboTimer <= 0) {
            comboCount = 0;
            comboMulti = 1;
            comboTimer = 0;
            updateComboHUD();
        }
    }

    for (let i = comboPopups.length - 1; i >= 0; i--) {
        const p = comboPopups[i];
        p.y     += p.vy;
        p.alpha -= 0.018;
        if (p.alpha <= 0) comboPopups.splice(i, 1);
    }
}

function spawnComboPopup(text, color) {
    comboPopups.push({
        text,
        color,
        x: CW / 2 + (Math.random() * 80 - 40),
        y: CH / 2 - 60,
        alpha: 1.0,
        vy: -1.4,
    });
}

function drawComboPopups() {
    for (const p of comboPopups) {
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.font        = '26px "Press Start 2P", monospace';
        ctx.textAlign   = 'center';
        ctx.fillStyle   = 'rgba(0,0,0,0.6)';
        ctx.fillText(p.text, p.x + 3, p.y + 3);
        ctx.fillStyle  = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur  = 18;
        ctx.fillText(p.text, p.x, p.y);
        ctx.restore();
    }
}

function updateComboHUD() {
    const el = document.getElementById('combo-hud');
    if (!el) return;
    if (comboCount >= 2) {
        el.textContent = `✦ COMBO ×${comboCount}`;
    } else {
        el.textContent = '';
    }
}

// ─── ASSETS ───────────────────────────────────────────────────────────────────
const images     = {};
const ASSET_PATH = 'assets/';

const assetList = [
    {name:'bg1',           src:'level1.png'},
    {name:'bg2',           src:'level2.png'},
    {name:'bg3',           src:'level3.png'},
    {name:'capy_idle',     src:'Idle.png'},
    {name:'capy_run',      src:'Run.png'},
    {name:'capy_hit',      src:'Hit.png'},
    {name:'capy_death',    src:'Death.png'},
    {name:'capy_atk1',     src:'Attack1.png'},
    {name:'capy_atk2',     src:'Attack2.png'},
    {name:'capy_atk3',     src:'Attack3.png'},
    {name:'capy_atk4',     src:'Attack4.png'},
    {name:'slime_sheet',   src:'slime-Sheet.png'},
    {name:'skeleton_walk', src:'Skeleton_01_White_Walk.png'},
    {name:'skeleton_atk',  src:'Skeleton_01_White_Attack1.png'},
    {name:'skeleton_die',  src:'Skeleton_01_White_Die.png'},
    {name:'skeleton_hurt', src:'Skeleton_01_White_Hurt.png'},
    {name:'golem_walk',    src:'Golem_1_walk.png'},
    {name:'golem_atk',     src:'Golem_1_attack.png'},
    {name:'golem_die',     src:'Golem_1_die.png'},
    {name:'golem_hurt',    src:'Golem_1_hurt.png'},
    {name:'symbols',       src:'line.png'},
    {name:'healthbar',     src:'Healtbar.png'},
];

// ─── PLAYER ───────────────────────────────────────────────────────────────────
class Player {
    constructor() {
        this.state         = 'idle';
        this.frameX        = 0;
        this.timer         = 0;
        this.gameOverFired = false;
        this._exiting      = false;
        this._exitDone     = false;
        this.facingLeft    = false;
        this._fwCache      = {};
        this._fhCache      = {};
        this._setCenter();
    }

    _frameW(state) {
        if (this._fwCache[state] !== undefined) return this._fwCache[state];
        const img = images['capy_' + state];
        if (!img || !img.complete || !img.naturalWidth) return 250;
        const maxF = SPRITE_DATA.capy.frames[state] ?? 6;
        this._fwCache[state] = img.naturalWidth / maxF;
        this._fhCache[state] = img.naturalHeight;
        return this._fwCache[state];
    }

    _frameH(state) {
        if (this._fhCache[state] !== undefined) return this._fhCache[state];
        this._frameW(state);
        return this._fhCache[state] ?? 250;
    }

    _setCenter() {
        const sc = SPRITE_DATA.capy.scale;
        this.x = Math.floor(CW / 2 - (this._frameW('idle') * sc) / 2);
        this.y = Math.floor(CH / 2 - (this._frameH('idle') * sc) / 2);
    }

    get drawW() { return Math.floor(this._frameW(this.state) * SPRITE_DATA.capy.scale); }
    get drawH() { return Math.floor(this._frameH(this.state) * SPRITE_DATA.capy.scale); }
    get centerX() { return this.x + Math.floor(this._frameW('idle') * SPRITE_DATA.capy.scale) / 2; }
    get centerY() { return this.y + this.drawH / 2; }

    get hitbox() {
        const hw = this.drawW * 0.30;
        const hh = this.drawH * 0.5;
        return { x: this.centerX - hw/2, y: this.y + (this.drawH - hh)/2, w: hw, h: hh };
    }

    setState(s) {
        if (this.state === 'death') return;
        this.state  = s;
        this.frameX = 0;
        this.timer  = 0;
        if (s === 'run') { this._exiting = true; this._exitDone = false; }
        else             { this._exiting = false; }
    }

    resetToCenter() {
        this._fwCache = {};
        this._fhCache = {};
        this._exiting = false; this._exitDone = false;
        this.state = 'idle'; this.frameX = 0; this.timer = 0;
        this.gameOverFired = false; this.facingLeft = false;
        this._setCenter();
    }

    _updateFacing() {
        let sumX = 0, count = 0;
        for (const e of enemies) {
            if (!e.markedForDeletion && e.state !== 'die') {
                sumX += e.x + e.drawW / 2; count++;
            }
        }
        if (count > 0) this.facingLeft = (sumX / count) < this.centerX;
    }

    update(dt) {
        const maxF = SPRITE_DATA.capy.frames[this.state] ?? 6;
        const spd  = SPRITE_DATA.capy.speed[this.state]  ?? 100;

        if (this._exiting && this.state === 'run' && !this._exitDone) {
            this.x += 7 * (dt / 16);
            if (this.x > CW + 20) {
                this._exitDone = true; this._exiting = false;
                if (typeof _onRunExitComplete === 'function') _onRunExitComplete();
            }
        }

        if (this.state === 'idle') this._updateFacing();

        this.timer += dt;
        if (this.timer < spd) return;
        this.timer -= spd;
        this.frameX++;

        if (this.frameX >= maxF) {
            if (this.state === 'death') {
                this.frameX = maxF - 1;
                if (!this.gameOverFired) {
                    this.gameOverFired = true;
                    setTimeout(triggerGameOver, 500);
                }
            } else if (this.state.startsWith('atk') || this.state === 'hit') {
                if (levelState !== 'TRANSITION') this.setState('idle');
            } else {
                this.frameX = 0;
            }
        }
    }

    draw() {
        const img = images['capy_' + this.state];
        if (!img || !img.complete) return;

        const fw = this._frameW(this.state);
        const fh = this._frameH(this.state);
        const sc = SPRITE_DATA.capy.scale;
        const dw = Math.floor(fw * sc);
        const dh = Math.floor(fh * sc);
        const dy = Math.floor(this.y);

        const baseDw       = Math.floor(this._frameW('idle') * sc);
        const stableCenterX = Math.floor(this.x) + Math.floor(baseDw / 2);
        const customOffset = Math.floor((SPRITE_DATA.capy.offsetX[this.state] || 0) * sc);

        ctx.save();
        if (this.facingLeft) {
            ctx.translate(stableCenterX, dy);
            ctx.scale(-1, 1);
            ctx.drawImage(img, this.frameX * fw, 0, fw, fh, Math.floor(-dw/2 + customOffset), 0, dw, dh);
        } else {
            ctx.drawImage(img, this.frameX * fw, 0, fw, fh, Math.floor(stableCenterX - dw/2 + customOffset), dy, dw, dh);
        }
        ctx.restore();
    }
}

let _onRunExitComplete = null;

// ─── ENEMY ────────────────────────────────────────────────────────────────────
class Enemy {
    constructor(type, side) {
        this.type              = type;
        this.side              = side;
        this.speed             = CFG.SPEED_MIN + Math.random() * (CFG.SPEED_MAX - CFG.SPEED_MIN);
        this.state             = 'walk';
        this.frameX            = 0;
        this.timer             = 0;
        this.attackCooldown    = 0;
        this.markedForDeletion = false;
        this.runes             = this._genRunes();

        const dh = this.drawH;
        this.y = Math.floor(100 + Math.random() * (CH - 100 - dh - 50));
        const dw = this.drawW;
        this.x = side === 'right' ? CW + 40 : -dw - 40;
    }

    _genRunes() {
        const all  = ['-','|','v','^'];
        const easy = ['-','|'];
        let count, pool;
        switch (this.type) {
            case 'slime':    count = 2; pool = easy; break;
            case 'skeleton': count = 3; pool = all;  break;
            case 'golem':    count = 4; pool = all;  break;
            default:         count = 2; pool = easy;
        }
        return Array.from({length: count}, () => pool[Math.floor(Math.random() * pool.length)]);
    }

    get drawW() { return Math.floor(SPRITE_DATA[this.type].fw * SPRITE_DATA[this.type].scale); }
    get drawH() { return Math.floor(SPRITE_DATA[this.type].fh * SPRITE_DATA[this.type].scale); }
    _maxF()     { return SPRITE_DATA[this.type].frames[this.state]; }
    _spd()      { return SPRITE_DATA[this.type].speed[this.state]; }

    _setState(s) {
        if (this.state === s) return;
        this.state = s; this.frameX = 0; this.timer = 0;
    }

    _shouldMirror() {
        const facing = SPRITE_DATA[this.type].defaultFacing ?? 'right';
        return facing === 'left' ? this.side === 'left' : this.side === 'right';
    }

    update(dt) {
        if (!player) return;

        if (this.state === 'die') {
            this.timer += dt;
            if (this.timer >= this._spd()) {
                this.timer -= this._spd();
                this.frameX++;
                if (this.frameX >= this._maxF()) this.markedForDeletion = true;
            }
            return;
        }

        if (this.state === 'hurt') {
            this.timer += dt;
            if (this.timer >= this._spd()) {
                this.timer -= this._spd();
                this.frameX++;
                if (this.frameX >= this._maxF()) this._setState('walk');
            }
            return;
        }

        const px   = player.centerX, py = player.centerY;
        const ex   = this.x + this.drawW/2, ey = this.y + this.drawH/2;
        const dist = Math.hypot(px - ex, py - ey);
        const hb   = player.hitbox;
        const atkR = this.drawW * 0.45 + hb.w * 0.5;

        if (dist > atkR) {
            const angle = Math.atan2(py - ey, px - ex);
            this.x += Math.cos(angle) * this.speed * (dt / 16);
            this.y += Math.sin(angle) * this.speed * (dt / 16);
            if (this.state !== 'walk') this._setState('walk');
        } else {
            if (this.state !== 'atk') { this._setState('atk'); this.attackCooldown = 0; }
        }

        this.timer += dt;
        if (this.timer >= this._spd()) {
            this.timer -= this._spd();
            this.frameX++;
            if (this.state === 'atk' && this.frameX === 5 && this.attackCooldown === 0) {
                takeDamage();
                this.attackCooldown = 1;
            }
            if (this.frameX >= this._maxF()) {
                this.frameX = 0;
                if (this.state === 'atk') this.attackCooldown = 0;
            }
        }
    }

    draw() {
        let img, srcX, srcY;
        const fw    = SPRITE_DATA[this.type].fw;
        const fh    = SPRITE_DATA[this.type].fh;
        const state = this.state;

        if (this.type === 'slime') {
            img  = images['slime_sheet'];
            srcX = this.frameX * fw;
            srcY = (SPRITE_DATA.slime.rows[state] ?? 0) * fh;
        } else {
            img  = images[`${this.type}_${state}`];
            srcX = this.frameX * fw;
            srcY = 0;
        }

        if (!img || !img.complete) return;

        const dw = this.drawW, dh = this.drawH;
        const dx = Math.floor(this.x), dy = Math.floor(this.y);

        if (state === 'hurt') ctx.filter = 'brightness(2) sepia(1) hue-rotate(315deg) saturate(3)';

        ctx.save();
        if (this._shouldMirror()) {
            ctx.translate(dx + dw, dy); ctx.scale(-1, 1);
            ctx.drawImage(img, srcX, srcY, fw, fh, 0, 0, dw, dh);
        } else {
            ctx.drawImage(img, srcX, srcY, fw, fh, dx, dy, dw, dh);
        }
        ctx.restore();
        ctx.filter = 'none';

        // Rune bar
        if (state !== 'die' && this.runes.length > 0) {
            const symImg = images['symbols'];
            if (!symImg || !symImg.complete) return;
            const iconW = 44, gap = 7;
            const totalW = this.runes.length * (iconW + gap) - gap;
            const sx = Math.floor(this.x + dw/2 - totalW/2);
            const offsetY = SPRITE_DATA[this.type].runeOffsetY ?? -60;
            const sy = Math.floor(this.y + offsetY);

            ctx.save();
            ctx.globalAlpha = 0.65;
            ctx.fillStyle = '#000';
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(sx-6, sy-5, totalW+12, iconW+10, 7);
            else ctx.rect(sx-6, sy-5, totalW+12, iconW+10);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.restore();

            this.runes.forEach((r, i) => {
                const idx = ['-','|','v','^'].indexOf(r);
                if (idx !== -1)
                    ctx.drawImage(symImg, idx*32, 0, 32, 32, Math.floor(sx + i*(iconW+gap)), sy, iconW, iconW);
            });
        }
    }
}

let player = null;

// ─── ASSET LOADING ────────────────────────────────────────────────────────────
function initGameEngine() {
    let settled = 0, errCount = 0;
    const total = assetList.length;
    assetList.forEach(asset => {
        const img   = new Image();
        img.onload  = () => { settled++; if (settled === total) onAllAssetsSettled(errCount); };
        img.onerror = () => { settled++; errCount++; console.warn('[MISSING]', asset.src); if (settled === total) onAllAssetsSettled(errCount); };
        img.src = ASSET_PATH + asset.src;
        images[asset.name] = img;
    });
}
function onAllAssetsSettled() { startFresh(); }

// ─── START / RESET ────────────────────────────────────────────────────────────
function resetLevel() { startFresh(); }

function startFresh() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }

    player             = new Player();
    playerHp           = 3; _prevHp = 3;
    score              = 0;
    currentLevel       = 1;
    levelState         = 'PLAYING';
    enemies            = [];
    levelTitleText     = '';
    levelTitleAlpha    = 0;
    fadeAlpha          = 1; fadeDir = 0;
    fadeCallback       = null;
    _onRunExitComplete = null;
    shakeMag           = 0;
    comboCount         = 0;
    comboTimer         = 0;
    comboMulti         = 1;
    comboPopups        = [];

    _buildQueue(1);
    updateHUD();

    isPlaying   = true;
    lastTime    = performance.now();
    animFrameId = requestAnimationFrame(gameLoop);

    doLevelCinematic(1, () => { fadeDir = -1; fadeSpeed = 0.03; levelState = 'PLAYING'; });
}

// ─── SPAWN QUEUE ──────────────────────────────────────────────────────────────
function _buildQueue(level) {
    spawnQueue       = [];
    spawnTimer       = 0;
    phaseJedaTimer   = 0;
    waitingNextPhase = false;
    levelCleared     = false;

    const phases = LEVEL_PHASES[level] ?? [];
    phases.forEach((phase, phaseIdx) => {
        for (let i = 0; i < phase.count; i++) {
            const side = i % 2 === 0 ? 'right' : 'left';
            spawnQueue.push({type: phase.type, side});
        }
        if (phaseIdx < phases.length - 1) spawnQueue.push({type: '__PHASE_JEDA__'});
    });
}

function tickSpawn(dt) {
    if (levelState !== 'PLAYING') return;

    if (waitingNextPhase) {
        phaseJedaTimer -= dt;
        if (phaseJedaTimer <= 0) { waitingNextPhase = false; phaseJedaTimer = 0; spawnTimer = 0; }
        return;
    }

    if (spawnQueue.length === 0) return;

    spawnTimer -= dt;
    if (spawnTimer > 0) return;

    const entry = spawnQueue.shift();

    if (entry.type === '__PHASE_JEDA__') {
        waitingNextPhase = true;
        phaseJedaTimer   = CFG.PHASE_JEDA_MS;
        spawnTimer       = 0;
        return;
    }

    enemies.push(new Enemy(entry.type, entry.side));
    spawnTimer = CFG.SPAWN_INTERVAL_MS;
}

// ─── LEVEL PROGRESS ───────────────────────────────────────────────────────────
function checkLevelProgress() {
    if (levelState !== 'PLAYING' || levelCleared) return;
    if (spawnQueue.length > 0 || waitingNextPhase) return;
    if (enemies.filter(e => !e.markedForDeletion).length > 0) return;

    levelCleared = true;
    doLevelClear();
}

// ─── CINEMATIC ────────────────────────────────────────────────────────────────
function doLevelCinematic(level, onDone) {
    levelTitleText  = `LEVEL  ${level}`;
    levelTitleAlpha = 0;

    const FADE_IN = 400, HOLD = 1800, FADE_OUT = 400, TOTAL = FADE_IN + HOLD + FADE_OUT;
    let elapsed = 0;
    const tick = () => {
        elapsed += 16;
        if      (elapsed < FADE_IN)        levelTitleAlpha = elapsed / FADE_IN;
        else if (elapsed < FADE_IN + HOLD) levelTitleAlpha = 1;
        else if (elapsed < TOTAL)          levelTitleAlpha = 1 - (elapsed - FADE_IN - HOLD) / FADE_OUT;
        else                               levelTitleAlpha = 0;

        if (elapsed < TOTAL) setTimeout(tick, 16);
        else { levelTitleText = ''; levelTitleAlpha = 0; if (onDone) onDone(); }
    };
    setTimeout(tick, 16);
}

// ─── DAMAGE ───────────────────────────────────────────────────────────────────
function takeDamage() {
    if (!player || player.state === 'hit' || player.state === 'death' || levelState === 'TRANSITION') return;
    
    // --- EFEK BARU: Trigger Screen Shake ---
    screenShakeTimer = 300; // Bergetar selama 300ms
    
    playerHp = Math.max(0, playerHp - 1);
    updateHUD();
    if (playerHp <= 0) player.setState('death');
    else               player.setState('hit');
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function updateHUD() {
    const elScore = document.getElementById('current-score');
    const elLevel = document.getElementById('current-level');
    if (elScore) elScore.textContent = score.toLocaleString();
    if (elLevel) elLevel.textContent = currentLevel;

    // Export score for HTML to read
    window._currentScore = score;

    const posMap = {3:'0%', 2:'33.3%', 1:'66.6%', 0:'100%'};
    const pos = posMap[playerHp] ?? '100%';

    const mainEl = document.getElementById('health-bar-img');
    if (mainEl) {
        mainEl.style.transition = 'none';
        mainEl.style.backgroundPositionY = pos;
        void mainEl.offsetHeight;
    }

    const shadowEl = document.getElementById('health-bar-shadow');
    if (shadowEl && playerHp < _prevHp) {
        setTimeout(() => {
            shadowEl.style.transition = 'background-position-y 0.7s ease';
            shadowEl.style.backgroundPositionY = pos;
        }, 80);
    }
    _prevHp = playerHp;
}

// ─── AOE GESTURE ──────────────────────────────────────────────────────────────
function processGesture(symbol) {
    if (!isPlaying || levelState !== 'PLAYING' || fadeAlpha > 0.1) return;

    const atkMap = {'-':'atk1', '|':'atk2', 'v':'atk3', '^':'atk4'};
    let killsThisSwing = 0;
    let anyHit = false;

    for (const e of enemies) {
        if (e.state === 'die' || e.markedForDeletion || e.runes.length === 0) continue;
        if (e.runes[0] !== symbol) continue;

        const dist = Math.hypot(
            (e.x + e.drawW/2) - player.centerX,
            (e.y + e.drawH/2) - player.centerY
        );
        if (dist > CFG.AOE_RADIUS) continue;

        anyHit = true;
        e.runes.shift();

        if (e.runes.length === 0) {
            e._setState('die');
            const baseScore = e.type === 'golem' ? 1000 : e.type === 'skeleton' ? 300 : 100;
            score += baseScore * comboMulti;
            killsThisSwing++;
        } else {
            e._setState('hurt');
            const angle = Math.atan2(
                (e.y + e.drawH/2) - player.centerY,
                (e.x + e.drawW/2) - player.centerX
            );
            e.x += Math.cos(angle) * CFG.KNOCKBACK_X;
            e.y += Math.sin(angle) * CFG.KNOCKBACK_Y;
        }
    }

    if (anyHit) {
        if (levelState !== 'TRANSITION') player.setState(atkMap[symbol] ?? 'atk1');
        if (killsThisSwing > 0) registerKill(killsThisSwing);
        updateHUD();
    }
}

// ─── LEVEL CLEAR ──────────────────────────────────────────────────────────────
function doLevelClear() {
    levelState = 'TRANSITION';
    enemies    = [];
    spawnQueue = [];

    player.facingLeft = false;
    player.setState('run');

    _onRunExitComplete = () => {
        fadeDir = 1; fadeSpeed = 0.04;
        fadeCallback = () => {
            currentLevel++;
            if (currentLevel > 3) { setTimeout(triggerWin, 300); return; }

            player.resetToCenter();
            _prevHp = playerHp;
            updateHUD();
            _buildQueue(currentLevel);

            doLevelCinematic(currentLevel, () => {
                fadeDir = -1; fadeSpeed = 0.03;
                levelState = 'PLAYING';
            });
        };
    };
}

// ─── FADE OVERLAY ─────────────────────────────────────────────────────────────
function drawFadeOverlay() {
    if (fadeDir === 1) {
        fadeAlpha = Math.min(1, fadeAlpha + fadeSpeed);
        if (fadeAlpha >= 1 && fadeCallback) {
            const cb = fadeCallback; fadeCallback = null; fadeDir = 0; cb();
        }
    } else if (fadeDir === -1) {
        fadeAlpha = Math.max(0, fadeAlpha - fadeSpeed);
        if (fadeAlpha <= 0) { fadeAlpha = 0; fadeDir = 0; }
    }

    if (fadeAlpha > 0) {
        ctx.globalAlpha = fadeAlpha;
        ctx.fillStyle   = '#000';
        ctx.fillRect(0, 0, CW, CH);
        ctx.globalAlpha = 1;
    }

    if (levelTitleText && levelTitleAlpha > 0) {
        ctx.save();
        ctx.globalAlpha  = levelTitleAlpha;
        ctx.font         = '64px "Press Start 2P", monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle    = 'rgba(0,0,0,0.70)';
        ctx.fillText(levelTitleText, CW/2+6, CH/2+6);
        ctx.shadowColor  = '#7c3aed';
        ctx.shadowBlur   = 42;
        ctx.fillStyle    = '#fbbf24';
        ctx.fillText(levelTitleText, CW/2, CH/2);
        ctx.restore();
    }
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────
// ─── GAME LOOP ────────────────────────────────────────────────────────────────
function gameLoop(ts) {
    if (!isPlaying) return;
    const dt = Math.min(ts - lastTime, 50);
    lastTime = ts;

    // --- EFEK BARU: Hitung Screen Shake Offset ---
    let shakeX = 0, shakeY = 0;
    if (screenShakeTimer > 0) {
        screenShakeTimer -= dt;
        shakeX = (Math.random() - 0.5) * SHAKE_INTENSITY;
        shakeY = (Math.random() - 0.5) * SHAKE_INTENSITY;
    }

    ctx.clearRect(0, 0, CW, CH);
    
    // Terapkan getaran saat menggambar background & objek
    ctx.save();
    ctx.translate(shakeX, shakeY); 

    const bg = images['bg' + Math.min(currentLevel, 3)];
    if (bg && bg.complete) ctx.drawImage(bg, 0, 0, CW, CH);
    else { ctx.fillStyle = '#0a0818'; ctx.fillRect(0, 0, CW, CH); }

    tickSpawn(dt);

    if (player) { player.update(dt); player.draw(); }

    for (let i = enemies.length - 1; i >= 0; i--) {
        enemies[i].update(dt);
        enemies[i].draw();
        if (enemies[i].markedForDeletion) enemies.splice(i, 1);
    }
    
    ctx.restore(); // Kembalikan posisi canvas normal (overlay tidak kena shake)

    checkLevelProgress();
    
    // Render combo text dan flash effect (tetap normal di atas getaran)
    // ... (kode rendering combo/flash lama) ...

    drawFadeOverlay();
    animFrameId = requestAnimationFrame(gameLoop);
}

// ─── GAME STATE ───────────────────────────────────────────────────────────────
function triggerGameOver() {
    isPlaying = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    window._currentScore = score;
    if (window.openLosePage) window.openLosePage();
    else document.getElementById('lose-page')?.classList.remove('hidden');
}

function triggerWin() {
    isPlaying = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    window._currentScore = score;
    if (window.openWinPage) window.openWinPage();
    else document.getElementById('win-page')?.classList.remove('hidden');
}

function stopGameEngine() {
    isPlaying = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

function pauseGameEngine() {
    isPlaying = false;
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

function resumeGameEngine() {
    if (!isPlaying) {
        isPlaying   = true;
        lastTime    = performance.now();
        animFrameId = requestAnimationFrame(gameLoop);
    }
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
    const map = {
        'a':'-', 'ArrowLeft':'-',
        'w':'|', 'ArrowUp':'|',
        's':'v', 'ArrowDown':'v',
        'd':'^', 'ArrowRight':'^'
    };
    if (map[e.key]) { e.preventDefault(); processGesture(map[e.key]); }
});

// ─── WEBSOCKET (IoT Glove ESP32) ──────────────────────────────────────────────
(function connectWS() {
    const IP = 'ws://192.168.4.1:81';
    let ws;
    function connect() {
        try {
            ws = new WebSocket(IP);
            ws.onopen    = () => console.log('%c[✓] IoT Glove Connected!', 'color:#22c55e;font-weight:bold');
            ws.onmessage = ev => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.gesture) processGesture(d.gesture);
                } catch(_) {}
            };
            ws.onerror = () => {};
            ws.onclose = () => setTimeout(connect, 3000);
        } catch(_) { setTimeout(connect, 3000); }
    }
    setTimeout(connect, 1200);
})();