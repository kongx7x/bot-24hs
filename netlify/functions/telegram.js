// Importações das bibliotecas necessárias
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const { message } = require('telegraf/filters');
const admin = require('firebase-admin');

// =================================================================================
// SEÇÃO DE CONFIGURAÇÃO DO BOT
// =================================================================================

// IMPORTANTE: Troque "nickname" abaixo pelo seu nome de usuário de suporte do Telegram (sem o @)
const SUPPORT_USERNAME = 'nickname';

// =================================================================================
// SEÇÃO DE CONFIGURAÇÃO INICIAL
// =================================================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FIREBASE_CREDS_JSON_STR = process.env.FIREBASE_CREDS_JSON;

// Inicializa o Firebase apenas uma vez
if (FIREBASE_CREDS_JSON_STR && !admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(FIREBASE_CREDS_JSON_STR);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase inicializado com sucesso.");
    } catch (e) {
        console.error("ERRO NA INICIALIZAÇÃO DO FIREBASE:", e);
    }
}
const db = admin.firestore();

// =================================================================================
// SEÇÃO DE CENAS (CONVERSAS)
// =================================================================================

const wizardIntervalScene = new Scenes.BaseScene('WIZARD_INTERVAL_SCENE');
wizardIntervalScene.on(message('text'), async (ctx) => {
    const timeStr = ctx.message.text;
    const unit = timeStr.slice(-1).toLowerCase();
    const value = parseInt(timeStr.slice(0, -1), 10);
    let seconds = 0;
    if (isNaN(value) || !['s', 'm', 'h'].includes(unit)) return ctx.reply("Formato inválido. Use um número seguido de s, m ou h (ex: 10s, 5m, 1h).");

    if (unit === 's') seconds = value;
    else if (unit === 'm') seconds = value * 60;
    else if (unit === 'h') seconds = value * 3600;

    if (seconds < 5) return ctx.reply("O intervalo mínimo é de 5 segundos.");

    const docId = ctx.session.docIdForWizard;
    await db.collection('scheduled_posts').doc(docId).update({ interval_seconds: seconds });
    console.log(`[Wizard] Intervalo de ${seconds}s salvo para ${docId} pelo usuário ${ctx.from.id}`);

    const buttons = Markup.inlineKeyboard([
        Markup.button.callback("✅ Sim, iniciar agora", `wizard_start_now:${docId}`),
        Markup.button.callback("Não, depois", `wizard_start_later:${docId}`)
    ]);
    await ctx.reply(`✅ Intervalo definido para ${timeStr}!\n\nDeseja iniciar as postagens agora?`, buttons);
    return ctx.scene.leave();
});

function createContentScene(id, prompt, type, isAdding) {
    const scene = new Scenes.BaseScene(id);
    scene.enter((ctx) => ctx.reply(prompt));
    scene.on(message(type), async (ctx) => {
        if (!isAdding && !ctx.session.selectedChatId) {
            await ctx.reply("Selecione um grupo com /manage primeiro.");
            return ctx.scene.leave();
        }

        const content = {
            type: type,
            data: ctx.message[type]?.file_id || ctx.message.text,
            caption: ctx.message.caption_html || null
        };
        if (type === 'photo') content.data = ctx.message.photo.pop().file_id;

        if (isAdding) {
            const docId = ctx.scene.state.docId;
            await db.collection('scheduled_posts').doc(docId).update({ content_items: admin.firestore.FieldValue.arrayUnion(content) });
            await ctx.reply("✅ Novo conteúdo adicionado com sucesso a este agendamento!");
            console.log(`[Scene] Conteúdo do tipo ${type} adicionado ao agendamento ${docId} pelo usuário ${ctx.from.id}`);
        } else {
            const docRef = await db.collection('scheduled_posts').add({
                chat_id: ctx.session.selectedChatId, user_id: ctx.from.id, chat_title: ctx.session.selectedChatTitle,
                is_active: false, interval_seconds: null, content_items: [content],
                current_index: 0, content_type: type
            });
            await ctx.reply(`✅ Agendamento de ${type} criado!`);
            console.log(`[Wizard] Iniciando para o novo agendamento ${docRef.id}`);
            ctx.session.docIdForWizard = docRef.id;
            await ctx.reply("⏰ Agora, envie o intervalo (ex: 10s, 5m, 1h).");
            return ctx.scene.enter('WIZARD_INTERVAL_SCENE');
        }
        return ctx.scene.leave();
    });
    return scene;
}

const newTextScene = createContentScene('NEW_TEXT_SCENE', 'Envie o primeiro texto para este novo agendamento.', 'text', false);
const newImgScene = createContentScene('NEW_IMG_SCENE', 'Envie a primeira imagem para este novo agendamento.', 'photo', false);
const addTextScene = createContentScene('ADD_TEXT_SCENE', 'Envie o novo texto para adicionar.', 'text', true);
const addImgScene = createContentScene('ADD_IMG_SCENE', 'Envie a nova imagem para adicionar.', 'photo', true);

const stage = new Scenes.Stage([newTextScene, newImgScene, wizardIntervalScene, addTextScene, addImgScene]);

// =================================================================================
// SEÇÃO DE SETUP E COMANDOS DO BOT
// =================================================================================

const bot = new Telegraf(TELEGRAM_TOKEN);
bot.use(session());
bot.use(stage.middleware());

async function showManageMenu(ctx) {
    if (ctx.chat.type !== 'private') return ctx.reply("Use este comando no nosso chat privado.");
    const groupsSnapshot = await db.collection('user_groups').where('user_id', '==', ctx.from.id).get();
    if (groupsSnapshot.empty) return ctx.reply("Nenhum grupo registrado. Use /setconfig em um grupo.");
    const buttons = groupsSnapshot.docs.map(doc => [Markup.button.callback(doc.data().chat_title, `select_group:${doc.data().chat_id}`)]);
    await ctx.reply("Selecione um grupo para gerenciar:", Markup.inlineKeyboard(buttons));
}

bot.start(async (ctx) => {
    console.log(`[Command] /start recebido do usuário ${ctx.from.id}`);
    if (ctx.startPayload === 'manage') {
        return showManageMenu(ctx);
    }
    
    const welcomeMessage = `Olá, ${ctx.from.first_name}! 👋\n\n` +
        "Eu sou seu assistente para agendar postagens automáticas em grupos.\n\n" +
        "<b>Como funciona:</b>\n" +
        "1. Me adicione a um grupo onde você é <b>administrador</b>.\n" +
        "2. No grupo, digite o comando <code>/setconfig</code> para registrá-lo.\n" +
        "3. Volte aqui e use <code>/manage</code> para escolher o grupo e criar suas postagens.\n\n" +
        "Use <code>/help</code> para ver a lista de comandos.";

    await ctx.replyWithHTML(welcomeMessage);
});

bot.help(async (ctx) => {
    const helpText = "ℹ️ *Novidades e Comandos*\n\n" +
        "🆕 *Postagem em Rotação*: Cada agendamento é uma playlist\\! Use o botão `➕ Adicionar` no `/list` para incluir mais conteúdos no mesmo agendamento\\.\n\n" +
        "✨ *Assistente de Configuração*: Ao criar uma postagem, o bot te guiará para definir o intervalo e iniciar\\.\n\n" +
        "*Comandos Principais:*\n" +
        "`/setconfig` \\- *\\(No GRUPO\\)* Registra o grupo\\.\n" +
        "`/manage` \\- *\\(No PRIVADO\\)* Seleciona um grupo\\.\n" +
        "`/newtext`, `/newimg` \\- Criam um *NOVO* agendamento\\.\n" +
        "`/list` \\- Mostra seus agendamentos e permite gerenciar cada um\\.";

    const supportButton = Markup.inlineKeyboard([
        Markup.button.url("💬 Suporte", `https://t.me/${SUPPORT_USERNAME}`)
    ]);

    await ctx.replyWithMarkdownV2(helpText, supportButton);
});

bot.command('setconfig', async (ctx) => {
    console.log(`[Command] /setconfig recebido do usuário ${ctx.from.id} no chat ${ctx.chat.id}`);
    if (ctx.chat.type === 'private') return ctx.reply("Use este comando dentro de um grupo.");
    try {
        const admins = await ctx.getChatAdministrators();
        if (!admins.some(admin => admin.user.id === ctx.from.id)) return ctx.reply("❌ Apenas administradores podem usar este comando.");
        
        await db.collection('user_groups').doc(`${ctx.from.id}_${ctx.chat.id}`).set({
            user_id: ctx.from.id, chat_id: ctx.chat.id, chat_title: ctx.chat.title
        });
        const button = Markup.inlineKeyboard([Markup.button.url("⚙️ Gerenciar no Privado", `https://t.me/${ctx.botInfo.username}?start=manage`)]);
        await ctx.reply("✅ Grupo registrado! Volte ao chat privado para gerenciar.", button);
    } catch (error) {
        console.error("Erro no /setconfig:", error);
        await ctx.reply("Ocorreu um erro. Verifique se sou um administrador no grupo.");
    }
});

bot.command('manage', showManageMenu);
bot.command(['newtext', 'settext'], (ctx) => {
    if (!ctx.session.selectedChatId) return ctx.reply("Use /manage para selecionar um grupo primeiro.");
    ctx.scene.enter('NEW_TEXT_SCENE')
});
bot.command(['newimg', 'setimg'], (ctx) => {
    if (!ctx.session.selectedChatId) return ctx.reply("Use /manage para selecionar um grupo primeiro.");
    ctx.scene.enter('NEW_IMG_SCENE')
});

bot.command('list', async (ctx) => {
    if (!ctx.session.selectedChatId) return ctx.reply("Nenhum grupo selecionado. Use /manage.");
    
    const postsSnapshot = await db.collection('scheduled_posts').where('chat_id', '==', ctx.session.selectedChatId).get();
    if (postsSnapshot.empty) return ctx.reply(`Nenhum agendamento para '${ctx.session.selectedChatTitle}'. Use /newtext ou /newimg.`);
    
    const safeTitle = (ctx.session.selectedChatTitle || '').replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
    await ctx.replyWithMarkdownV2(`Abaixo estão os agendamentos para *${safeTitle}*:`);

    for (const doc of postsSnapshot.docs) {
        const post = doc.data();
        const status = post.is_active ? "Ativo ▶️" : "Pausado ⏸️";
        const ctype = (post.content_type || 'N/D').charAt(0).toUpperCase() + (post.content_type || 'N/D').slice(1);
        const itemCount = post.content_items ? post.content_items.length : 0;
        const interval = post.interval_seconds ? `${post.interval_seconds}s` : "Não definido";
        const text = `*Agendamento de ${ctype}* \\(${itemCount} itens\\) \\| *Status:* ${status} \\| *Intervalo:* ${interval}`;
        const buttons = Markup.inlineKeyboard([
            Markup.button.callback(post.is_active ? "⏸️ Pausar" : "▶️ Iniciar", `toggle:${doc.id}`),
            Markup.button.callback("➕ Adicionar", `add_content:${doc.id}`),
            Markup.button.callback("🗑️ Excluir", `delete:${doc.id}`)
        ]);
        await ctx.replyWithMarkdownV2(text, buttons);
    }
});

// =================================================================================
// SEÇÃO DE AÇÕES (BOTÕES)
// =================================================================================

// ***** CÓDIGO CORRIGIDO ABAIXO *****
bot.action(/select_group:(.+)/, async (ctx) => {
    try {
        const chatId = parseInt(ctx.match[1], 10);
        ctx.session.selectedChatId = chatId;

        const snapshot = await db.collection('user_groups')
            .where('user_id', '==', ctx.from.id)
            .where('chat_id', '==', chatId)
            .limit(1)
            .get();

        if (!snapshot.empty) {
            ctx.session.selectedChatTitle = snapshot.docs[0].data().chat_title;
            console.log(`[Action] Usuário ${ctx.from.id} selecionou o grupo ${ctx.session.selectedChatTitle} (${chatId})`);
            await ctx.editMessageText(`✅ Grupo '${ctx.session.selectedChatTitle}' selecionado. Use /list para gerenciar.`);
        } else {
            await ctx.answerCbQuery("Grupo não encontrado.", { show_alert: true });
            await ctx.editMessageText("Este grupo não foi encontrado ou não está associado a você.");
        }
    } catch (error) {
        console.error("Erro na action select_group:", error);
        await ctx.answerCbQuery("Ocorreu um erro ao selecionar o grupo.", { show_alert: true });
    }
});

bot.action(/toggle:(.+)/, async (ctx) => {
    const docId = ctx.match[1];
    const docRef = db.collection('scheduled_posts').doc(docId);
    const doc = await docRef.get();
    if (!doc.exists) return ctx.answerCbQuery("Agendamento não encontrado.");
    
    const post = doc.data();
    const isNowActive = !post.is_active;

    await docRef.update({ 
        is_active: isNowActive,
        // Zera o timestamp ao ativar para garantir que ele rode no próximo ciclo do cron
        last_run_timestamp: 0 
    });

    await ctx.answerCbQuery(isNowActive ? "Agendamento ativado." : "Agendamento pausado.");
    console.log(`[Action] Agendamento ${docId} ${isNowActive ? 'ativado' : 'pausado'} pelo usuário ${ctx.from.id}`);
});

bot.action(/add_content:(.+)/, async (ctx) => {
    const docId = ctx.match[1];
    const doc = await db.collection('scheduled_posts').doc(docId).get();
    if (!doc.exists) return ctx.answerCbQuery("Agendamento não encontrado.");
    const contentType = doc.data().content_type;
    console.log(`[Action] Usuário ${ctx.from.id} solicitou adicionar ${contentType} ao doc ${docId}`);
    if (contentType === 'text') ctx.scene.enter('ADD_TEXT_SCENE', { docId });
    else if (contentType === 'photo') ctx.scene.enter('ADD_IMG_SCENE', { docId });
    await ctx.answerCbQuery();
});

bot.action(/delete:(.+)/, async (ctx) => {
    const docId = ctx.match[1];
    await db.collection('scheduled_posts').doc(docId).delete();
    await ctx.editMessageText("🗑️ Agendamento excluído.");
    console.log(`[Action] Agendamento ${docId} excluído pelo usuário ${ctx.from.id}`);
});

bot.action(/wizard_start_now:(.+)/, async (ctx) => {
    const docId = ctx.match[1];
    await db.collection('scheduled_posts').doc(docId).update({ 
        is_active: true,
        last_run_timestamp: 0
    });
    await ctx.editMessageText("✅ Agendamento ativado! Os posts começarão a ser enviados em breve (a verificação ocorre a cada minuto).");
    console.log(`[Wizard] Agendamento ${docId} ativado via assistente pelo usuário ${ctx.from.id}`);
});

bot.action(/wizard_start_later:(.+)/, (ctx) => ctx.editMessageText("✅ Ok! Agendamento salvo. Use /list para ativá-lo."));

// =================================================================================
// SEÇÃO DO HANDLER PRINCIPAL DO NETLIFY
// =================================================================================

exports.handler = async (event) => {
    try {
        await bot.handleUpdate(JSON.parse(event.body));
        return { statusCode: 200, body: "" };
    } catch (e) {
        console.error("ERRO AO PROCESSAR O UPDATE:", e);
        return { statusCode: 400, body: "Erro no processamento." };
    }
};
