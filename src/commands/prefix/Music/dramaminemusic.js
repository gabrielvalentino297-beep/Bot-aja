const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const def = require('../../../../defines');

const BANNER_GIF = 'https://cdn.discordapp.com/attachments/1503767759182631022/1509488557352550430/standard.gif?ex=6a195c45&is=6a180ac5&hm=cdda3a27d582d7e93f8eabc504500929e6647b85ce07b38409433260ad8061bb&';
const RAPIDAPI_KEY = '52b4b1934fmsh6b38c1ca78d57cbp128e0ejsnf06dcf923add';

const MUSIC_DIR  = path.join(__dirname, '../../../../data/music');
const CACHE_FILE = path.join(__dirname, '../../../../data/music_cache.json');

const ALLOWED_CHANNELS = ['1506632252853977183', '1509813907005636689'];

if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

const queues = new Map();

class QueueManager {
    constructor(guildId) {
        this.guildId      = guildId;
        this.queue        = [];
        this.currentIndex = 0;
        this.isPlaying    = false;
        this.connection   = null;
        this.player       = null;
        this.volume       = 0.5;
        this.loop         = false;
        this.loopQueue    = false;
    }
    add(track)    { this.queue.push(track); }
    current()     { return this.queue[this.currentIndex] || null; }
    next() {
        if (this.loop) return this.current();
        if (this.currentIndex + 1 < this.queue.length) { this.currentIndex++; return this.current(); }
        if (this.loopQueue && this.queue.length > 0)   { this.currentIndex = 0; return this.current(); }
        return null;
    }
    destroy() {
        try { this.player?.stop(true); }    catch {}
        try { this.connection?.destroy(); } catch {}
        this.queue = []; this.isPlaying = false;
        this.player = null; this.connection = null;
    }
}

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    } catch { return {}; }
}
function saveCache(data) {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch {}
}

function getYoutubeId(url) {
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').slice(0, 80).trim();
}

async function getUserVoiceChannel(message) {
    try {
        const member = await message.guild.members.fetch({ user: message.author.id, force: true });
        if (!member?.voice?.channelId) return null;
        return await message.guild.channels.fetch(member.voice.channelId).catch(() => null);
    } catch {
        const member = message.member;
        if (!member?.voice?.channelId) return null;
        return await message.guild.channels.fetch(member.voice.channelId).catch(() => null);
    }
}

async function getMP3Link(videoId) {
    const res = await axios.get(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
        headers: {
            'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com',
            'x-rapidapi-key': RAPIDAPI_KEY
        },
        timeout: 60000
    });
    const data = res.data;
    if (!data || data.status !== 'ok') throw new Error(data?.msg || 'Gagal ambil MP3 dari RapidAPI');
    if (!data.link) throw new Error('Tidak ada download link dari RapidAPI');
    return { downloadUrl: data.link, title: data.title || 'Unknown' };
}

async function downloadMP3(url, outPath) {
    const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 120000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function getTrack(youtubeUrl) {
    const videoId = getYoutubeId(youtubeUrl);
    if (!videoId) throw new Error('URL YouTube tidak valid');

    const cache = loadCache();

    if (cache[videoId] && fs.existsSync(cache[videoId].file)) {
        const cached = cache[videoId];
        return {
            title:     cached.title,
            file:      cached.file,
            source:    '💾 Local Cache (instant)',
            duration:  cached.duration || 'Unknown',
            thumbnail: cached.thumbnail || null,
            fromCache: true
        };
    }

    if (cache[videoId] && !fs.existsSync(cache[videoId].file)) {
        delete cache[videoId];
        saveCache(cache);
    }

    const { downloadUrl, title } = await getMP3Link(videoId);
    const safeTitle = sanitizeFilename(title);
    const filePath  = path.join(MUSIC_DIR, `${videoId}_${safeTitle}.mp3`);

    await downloadMP3(downloadUrl, filePath);

    cache[videoId] = { title, file: filePath, duration: 'Unknown', thumbnail: null };
    saveCache(cache);

    return {
        title,
        file:      filePath,
        source:    '🌐 YouTube (baru di-download & disimpan)',
        duration:  'Unknown',
        thumbnail: null,
        fromCache: false
    };
}

async function playTrack(track, connection, guildQueue, textChannel) {
    const { createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');

    if (!guildQueue.player) {
        guildQueue.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Play }
        });
        connection.subscribe(guildQueue.player);
    }
    const player = guildQueue.player;

    const resource = createAudioResource(track.file, { inlineVolume: true });
    resource.volume?.setVolume(guildQueue.volume);
    player.play(resource);

    guildQueue.isPlaying       = true;
    guildQueue.currentResource = resource;

    player.removeAllListeners(AudioPlayerStatus.Idle);
    player.removeAllListeners('error');

    player.once(AudioPlayerStatus.Idle, async () => {
        guildQueue.isPlaying = false;
        const next = guildQueue.next();
        if (next) {
            await textChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor('#ff91b8')
                    .setTitle('▶️ Sekarang Memutar')
                    .setDescription(`**${next.title}**`)
                    .setImage(BANNER_GIF)
                    .setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })
                    .setTimestamp()]
            }).catch(() => {});
            await playTrack(next, connection, guildQueue, textChannel);
        } else {
            await textChannel.send({
                embeds: [new EmbedBuilder()
                    .setColor('#808080')
                    .setDescription('⏹️ Queue selesai. Bot keluar dari voice channel dalam 60 detik jika tidak ada lagu baru.')
                    .setImage(BANNER_GIF)
                    .setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })]
            }).catch(() => {});
            setTimeout(() => {
                if (!guildQueue.isPlaying) {
                    try { connection.destroy(); } catch {}
                    queues.delete(guildQueue.guildId);
                }
            }, 60000);
        }
    });

    player.on('error', async (err) => {
        guildQueue.isPlaying = false;
        await textChannel.send({ content: `❌ Error saat memutar: \`${err.message}\`` }).catch(() => {});
    });
}

async function handleSkip(message) {
    const guildQueue = queues.get(message.guild.id);
    if (!guildQueue || !guildQueue.isPlaying) {
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Tidak Ada Lagu').setDescription('Tidak ada lagu yang sedang diputar.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
    }
    guildQueue.player?.stop();
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff91b8').setTitle('⏭️ Lagu Dilewati').setDescription('Memutar lagu berikutnya...').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
}

async function handlePause(message) {
    const guildQueue = queues.get(message.guild.id);
    if (!guildQueue || !guildQueue.isPlaying) {
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Tidak Ada Lagu').setDescription('Tidak ada lagu yang sedang diputar.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
    }
    guildQueue.player?.pause();
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff91b8').setTitle('⏸️ Lagu Dipause').setDescription('Pemutaran dijeda.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
}

async function handleResume(message) {
    const guildQueue = queues.get(message.guild.id);
    if (!guildQueue) {
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Tidak Ada Lagu').setDescription('Tidak ada lagu yang sedang diputar.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
    }
    guildQueue.player?.unpause();
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff91b8').setTitle('▶️ Dilanjutkan').setDescription('Pemutaran dilanjutkan.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
}

async function handleStop(client, message) {
    const guildQueue = queues.get(message.guild.id);
    if (guildQueue) { guildQueue.destroy(); queues.delete(message.guild.id); }
    try {
        const botMember = await message.guild.members.fetch(client.user.id);
        if (botMember?.voice?.channelId) await botMember.voice.disconnect();
    } catch {}
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⏹️ Musik Dihentikan').setDescription('Pemutaran dihentikan dan bot keluar dari voice channel.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
}

async function handleLoop(message) {
    const guildQueue = queues.get(message.guild.id);
    if (!guildQueue) {
        return message.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Tidak Ada Lagu').setDescription('Tidak ada lagu yang sedang diputar.').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
    }
    guildQueue.loop = !guildQueue.loop;
    return message.reply({ embeds: [new EmbedBuilder().setColor('#ff91b8').setTitle('🔁 Mode Loop').setDescription(`Mode loop sekarang: **${guildQueue.loop ? 'ON' : 'OFF'}**`).setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
}

module.exports = {
    structure: {
        name: 'dramaminemusic',
        description: 'Stream lagu dari YouTube dengan cache lokal otomatis',
        aliases: ['dmusic', 'dm'],
        cooldown: 5000
    },

    run: async (client, message, args) => {
        if (!ALLOWED_CHANNELS.includes(message.channel.id)) {
            const reply = await message.reply({
                embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Channel Salah')
                    .setDescription(`Command ini hanya bisa digunakan di:\n${ALLOWED_CHANNELS.map(id => `<#${id}>`).join('\n')}`)
                    .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
            });
            setTimeout(() => { reply.delete().catch(() => {}); message.delete().catch(() => {}); }, 5000);
            return;
        }

        const sub = args[0]?.toLowerCase();
        if (sub === 'skip')   return handleSkip(message);
        if (sub === 'pause')  return handlePause(message);
        if (sub === 'resume') return handleResume(message);
        if (sub === 'stop')   return handleStop(client, message);
        if (sub === 'loop')   return handleLoop(message);

        const videoUrl = args[0];
        if (!videoUrl) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor('#ff91b8').setTitle('🎵 Cara Penggunaan')
                    .setDescription('**Format:**\n`!dramaminemusic <YouTube URL>`\n\n**Sub-commands:**\n`!dramaminemusic skip`\n`!dramaminemusic pause`\n`!dramaminemusic resume`\n`!dramaminemusic stop`\n`!dramaminemusic loop`')
                    .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
            });
        }

        const videoId = getYoutubeId(videoUrl);
        if (!videoId) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Bukan URL YouTube')
                    .setDescription('URL tidak valid.\n\nContoh:\n`https://youtu.be/xxxxx`')
                    .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
            });
        }

        const voiceChannel = await getUserVoiceChannel(message);
        if (!voiceChannel) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Kamu Belum di Voice Channel')
                    .setDescription('Join voice channel dulu!')
                    .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
            });
        }

        const cacheCheck = loadCache();
        const isInCache  = cacheCheck[videoId] && fs.existsSync(cacheCheck[videoId].file);

        const loadingMsg = await message.reply({
            embeds: [new EmbedBuilder().setColor('#3498db')
                .setTitle(isInCache ? '💾 Memuat dari Cache...' : '⏳ Sedang Mendownload...')
                .setDescription(isInCache ? 'Lagu ditemukan di data, sedang dipersiapkan...' : 'Sedang download...\n*(1-3 menit)*')
                .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
        });

        try {
            const track = await getTrack(videoUrl);
            track.requestedBy = message.author.tag;

            const guildId = message.guild.id;
            if (!queues.has(guildId)) queues.set(guildId, new QueueManager(guildId));
            const guildQueue = queues.get(guildId);
            guildQueue.add(track);

            const freshVoiceChannel = await getUserVoiceChannel(message);
            if (!freshVoiceChannel) {
                return loadingMsg.edit({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Kamu Sudah Keluar dari Voice Channel').setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail })] });
            }

            const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
            let connection = guildQueue.connection;
            if (!connection || connection.state.status === 'destroyed') {
                connection = joinVoiceChannel({
                    channelId:      freshVoiceChannel.id,
                    guildId:        guildId,
                    adapterCreator: message.guild.voiceAdapterCreator,
                    selfMute:       false,
                    selfDeaf:       false,
                });
                guildQueue.connection = connection;

                connection.on('stateChange', (oldState, newState) => {
                    console.log(`[DEBUG] 🔄 Connection state: ${oldState.status} → ${newState.status}`);
                });
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                        ]);
                    } catch {
                        try { connection.destroy(); } catch {}
                        queues.delete(guildId);
                    }
                });

                // Tunggu connection ready
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
                } catch {
                    console.warn('[DEBUG] ⚠️ Connection tidak ready dalam 20s, tetap lanjut...');
                }
            }

            const wasPlaying = guildQueue.isPlaying;

            if (!wasPlaying) {
                guildQueue.currentIndex = guildQueue.queue.length - 1;
                await playTrack(track, connection, guildQueue, message.channel);

                await loadingMsg.edit({
                    embeds: [new EmbedBuilder().setColor('#00ff88').setTitle('▶️ Sekarang Memutar')
                        .setDescription(`**${track.title}**`)
                        .addFields(
                            { name: '📌 Source',      value: track.source,   inline: true },
                            { name: '⏱️ Durasi',       value: track.duration, inline: true },
                            { name: '💾 Status Cache', value: track.fromCache ? '✅ Dari Cache Lokal' : '🆕 Baru Didownload & Disimpan', inline: false },
                            { name: '🔊 Volume',       value: `${Math.round(guildQueue.volume * 100)}%`, inline: true },
                            { name: '👤 Diminta oleh', value: track.requestedBy, inline: true }
                        )
                        .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
                });
            } else {
                const queuePos = guildQueue.queue.length - guildQueue.currentIndex;
                await loadingMsg.edit({
                    embeds: [new EmbedBuilder().setColor('#3498db').setTitle('📋 Ditambahkan ke Queue')
                        .setDescription(`**${track.title}**`)
                        .addFields(
                            { name: '📌 Source',      value: track.source,   inline: true },
                            { name: '⏱️ Durasi',       value: track.duration, inline: true },
                            { name: '🔢 Posisi Queue', value: `#${queuePos}`, inline: true },
                            { name: '💾 Status Cache', value: track.fromCache ? '✅ Dari Cache Lokal' : '🆕 Baru Didownload & Disimpan', inline: false },
                            { name: '👤 Diminta oleh', value: track.requestedBy, inline: true }
                        )
                        .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
                });
            }

        } catch (error) {
            console.error('[dramaminemusic] Error:', error);
            await loadingMsg.edit({
                embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Terjadi Error')
                    .setDescription(`Gagal memproses lagu:\n\`${error.message?.slice(0, 300)}\``)
                    .setImage(BANNER_GIF).setFooter({ text: `${def.servers.name} | © Copyright GABRIEL`, iconURL: def.icon.thumbnail }).setTimestamp()]
            });
        }
    }
};
