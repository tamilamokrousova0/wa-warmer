#!/usr/bin/env node
// Генерирует content-seed/<groupId>/messages.txt — по >=500 простых бытовых фраз
// на язык группы (ua=укр., de=нем., pl=польск., uk=англ.). Фразы собираются из
// готовых («singles»), мультипликативных фреймов (каждый префикс × список уже-в-
// нужной-форме фрагментов) и двухслотового «приветствие + вопрос». Затем
// дедуплицируются и обрезаются до TARGET. Медиа общие — здесь только тексты.
//
// Запуск: node scripts/seed-messages.mjs   (или npm run seed-messages)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGET = 500;

// каждый prefix + фрагмент (уже в правильной форме) + suffix — грамматичная фраза
const cross = (prefixes, items, suffix = '') =>
  prefixes.flatMap((p) => items.map((x) => `${p}${x}${suffix}`));
// «приветствие, вопрос» (вопросы со строчной буквы)
const greet = (openers, questions) =>
  openers.flatMap((o) => questions.map((q) => `${o}, ${q}`));

// ─────────────────────────── УКРАЇНСЬКА (ua) ───────────────────────────
const UA = () => {
  const out = [];
  const openers = ['Привіт', 'Привіт-привіт', 'Доброго ранку', 'Добрий день', 'Доброго вечора', 'Хей', 'Слухай', 'Здоров',
    'Йо', 'Вітаю', 'Гей', 'Привітик'];
  const questions = ['як ти?', 'як справи?', 'як настрій?', 'як воно?', 'що нового?', 'що робиш?', 'все добре?',
    'як день пройшов?', 'які плани на вечір?', 'ти вже пообідав?', 'каву будеш?', 'як робота?', 'що поробляєш?',
    'давно тебе не чув, як ти?', 'ти на зв’язку?', 'ще не спиш?', 'як настрій сьогодні?', 'що цікавого?', 'як вихідні?', 'ти вдома?',
    'багато сьогодні роботи?', 'як сам?', 'як здоров’я?', 'які плани на завтра?', 'вже прокинувся?', 'як тобі погода?',
    'як робота йде?', 'що плануєш робити?', 'як настрій, бадьорий?', 'давно не бачились, як життя?'];
  out.push(...greet(openers, questions));
  out.push('Привіт!', 'Доброго ранку!', 'Добрий день!', 'Доброго вечора!', 'На добраніч!',
    'Дякую!', 'Дуже дякую!', 'Нема за що.', 'Будь ласка.', 'Вибач, що пізно відповідаю.',
    'Згоден.', 'Повністю згоден.', 'Цікаво.', 'Гарна ідея!', 'Звучить непогано.',
    'Зрозуміло.', 'Ясно.', 'Домовились.', 'Добре, так і зробимо.', 'Без проблем.',
    'Побачимось незабаром!', 'До зустрічі!', 'Гарного дня!', 'Гарного вечора!', 'Бережи себе.',
    'Тримайся!', 'Наберу тебе пізніше.', 'Передзвоню трохи згодом.', 'Радий тебе чути.', 'Скучив за тобою.',
    'П’ю каву.', 'Тільки прокинувся.', 'Ще не снідав.', 'Зараз на роботі.', 'Трохи втомився.',
    'Нарешті вихідний.', 'Відпочиваю вдома.', 'Сьогодні багато справ.', 'Сонце світить, класно.', 'Люблю такі дні.');
  out.push(...cross(['Хочеш ', 'Може, разом ', 'Давай '], ['погуляти', 'прогулятися', 'зустрітися', 'зідзвонитися', 'випити кави',
    'пообідати', 'подивитися фільм', 'трохи пройтися', 'відпочити', 'сходити на каву', 'посидіти в кафе', 'зробити перерву'], '?'));
  out.push(...cross(['Мені треба ще ', 'Маю сьогодні ', 'Хочу ще '], ['попрацювати', 'відпочити', 'поспати', 'зробити покупки',
    'подзвонити', 'дещо доробити', 'приготувати вечерю', 'прибрати вдома', 'дещо купити', 'зібратися'], '.'));
  out.push(...cross(['Уже ', 'Ти вже '], ['поснідав', 'пообідав', 'повечеряв', 'прокинувся', 'на роботі', 'вдома',
    'закінчив роботу', 'вільний', 'відпочив', 'зайнятий'], '?'));
  out.push(...cross(['Який ', 'Ну і '], ['гарний', 'холодний', 'довгий', 'теплий', 'сонячний', 'дощовий', 'спокійний',
    'важкий', 'приємний', 'чудовий'], ' сьогодні день!'));
  out.push(...cross(['Сьогодні '], ['трохи втомився', 'гарний настрій', 'багато справ', 'нічого особливого',
    'все спокійно', 'важкий день', 'приємний день', 'хочеться відпочити', 'на роботі до вечора', 'вихідний, відпочиваю'], '.'));
  out.push(...cross(['Як там ', 'Ну як '], ['робота?', 'справи?', 'сім’я?', 'настрій?', 'погода у вас?', 'вихідні минули?', 'новий проєкт?', 'здоров’я?'], ''));
  return out;
};

// ─────────────────────────── DEUTSCH (de) ───────────────────────────
const DE = () => {
  const out = [];
  const openers = ['Hallo', 'Hey', 'Guten Morgen', 'Guten Tag', 'Guten Abend', 'Servus', 'Hi', 'Na',
    'Moin', 'Grüß dich', 'Hallöchen', 'Hey du'];
  const questions = ['wie geht’s?', 'wie geht es dir?', 'alles gut?', 'was gibt’s Neues?', 'was machst du gerade?',
    'wie war dein Tag?', 'was hast du heute Abend vor?', 'hast du schon gegessen?', 'magst du einen Kaffee?', 'wie läuft die Arbeit?',
    'alles in Ordnung?', 'lange nichts gehört, wie geht’s?', 'bist du erreichbar?', 'schon wach?', 'wie ist die Stimmung heute?',
    'was gibt’s bei dir?', 'wie war das Wochenende?', 'bist du zu Hause?', 'viel zu tun?', 'schon Feierabend?',
    'wie geht’s der Familie?', 'alles fit?', 'was machst du morgen?', 'schon Pläne fürs Wochenende?', 'wie ist das Wetter bei dir?',
    'hast du gut geschlafen?', 'läuft alles?', 'was steht heute an?', 'alles ruhig bei dir?', 'lange her, wie läuft’s?'];
  out.push(...greet(openers, questions));
  out.push('Hallo!', 'Guten Morgen!', 'Guten Tag!', 'Guten Abend!', 'Gute Nacht!',
    'Danke!', 'Vielen Dank!', 'Gern geschehen.', 'Kein Problem.', 'Entschuldige die späte Antwort.',
    'Einverstanden.', 'Ganz genau.', 'Interessant.', 'Gute Idee!', 'Klingt gut.',
    'Verstehe.', 'Alles klar.', 'Abgemacht.', 'Gut, machen wir so.', 'Passt.',
    'Bis bald!', 'Wir sehen uns!', 'Schönen Tag noch!', 'Schönen Abend!', 'Pass auf dich auf.',
    'Bleib gesund!', 'Ich rufe dich später an.', 'Melde mich gleich.', 'Schön, von dir zu hören.', 'Ich habe an dich gedacht.',
    'Ich trinke gerade Kaffee.', 'Bin gerade aufgestanden.', 'Ich habe noch nicht gefrühstückt.', 'Ich bin gerade bei der Arbeit.', 'Ich bin ein bisschen müde.',
    'Endlich Feierabend.', 'Ich entspanne mich zu Hause.', 'Heute ist viel zu tun.', 'Die Sonne scheint, super.', 'Ich mag solche Tage.');
  out.push(...cross(['Wollen wir ', 'Sollen wir ', 'Wie wäre es, wenn wir '], ['einen Kaffee trinken', 'spazieren gehen',
    'uns treffen', 'telefonieren', 'zusammen essen', 'einen Film schauen', 'kurz rausgehen', 'etwas unternehmen',
    'uns morgen sehen', 'ins Café gehen', 'eine Pause machen', 'uns am Wochenende treffen'], '?'));
  out.push(...cross(['Ich muss noch ', 'Ich habe heute vor zu ', 'Ich will noch '], ['arbeiten', 'einkaufen', 'schlafen',
    'telefonieren', 'etwas erledigen', 'kochen', 'aufräumen', 'mich fertig machen', 'Abendessen machen', 'ein paar Dinge klären'], '.'));
  out.push(...cross(['Hast du schon ', 'Bist du schon '], ['gegessen', 'gefrühstückt', 'aufgewacht', 'zu Hause', 'bei der Arbeit',
    'fertig mit der Arbeit', 'Feierabend', 'frei', 'ausgeruht', 'beschäftigt'], '?'));
  out.push(...cross(['Was für ein ', 'So ein '], ['schöner', 'kalter', 'langer', 'warmer', 'sonniger', 'ruhiger',
    'anstrengender', 'angenehmer', 'grauer', 'herrlicher'], ' Tag heute!'));
  out.push(...cross(['Heute '], ['bin ich etwas müde', 'ist gute Laune', 'ist viel zu tun', 'ist nichts Besonderes',
    'ist alles ruhig', 'war ein langer Tag', 'ist ein schöner Tag', 'will ich mich ausruhen', 'arbeite ich bis abends', 'habe ich frei'], '.'));
  out.push(...cross(['Wie ist ', 'Und wie ist '], ['die Arbeit?', 'die Stimmung?', 'die Familie?', 'das Wetter bei euch?',
    'dein Tag?', 'das Wochenende gelaufen?', 'das neue Projekt?', 'die Gesundheit?'], ''));
  return out;
};

// ─────────────────────────── POLSKI (pl) ───────────────────────────
const PL = () => {
  const out = [];
  const openers = ['Cześć', 'Hej', 'Dzień dobry', 'Dobry wieczór', 'Siema', 'Witaj', 'Hejka', 'No cześć',
    'Joł', 'Elo', 'Cześć cześć', 'Hej hej'];
  const questions = ['jak się masz?', 'co słychać?', 'jak leci?', 'co u ciebie?', 'co nowego?', 'co robisz?', 'wszystko w porządku?',
    'jak minął dzień?', 'jakie masz plany na wieczór?', 'jadłeś już coś?', 'masz ochotę na kawę?', 'jak w pracy?', 'co porabiasz?',
    'dawno cię nie słyszałem, jak się masz?', 'jesteś pod telefonem?', 'jeszcze nie śpisz?', 'jaki masz dziś humor?', 'co ciekawego?', 'jak weekend?', 'jesteś w domu?',
    'dużo dziś pracy?', 'jak zdrowie?', 'co u rodziny?', 'jakie plany na jutro?', 'już wstałeś?', 'jak pogoda u ciebie?',
    'jak praca idzie?', 'co planujesz?', 'wszystko spokojnie?', 'kopę lat, jak życie?'];
  out.push(...greet(openers, questions));
  out.push('Cześć!', 'Dzień dobry!', 'Dobry wieczór!', 'Dobranoc!', 'Do zobaczenia!',
    'Dziękuję!', 'Wielkie dzięki!', 'Nie ma za co.', 'Proszę bardzo.', 'Przepraszam za późną odpowiedź.',
    'Zgadzam się.', 'Dokładnie.', 'Ciekawe.', 'Dobry pomysł!', 'Brzmi nieźle.',
    'Rozumiem.', 'Jasne.', 'Umowa stoi.', 'Dobra, tak zróbmy.', 'Bez problemu.',
    'Do zobaczenia wkrótce!', 'Na razie!', 'Miłego dnia!', 'Miłego wieczoru!', 'Uważaj na siebie.',
    'Trzymaj się!', 'Zadzwonię później.', 'Odezwę się niedługo.', 'Miło cię słyszeć.', 'Myślałem o tobie.',
    'Piję kawę.', 'Dopiero wstałem.', 'Jeszcze nie jadłem śniadania.', 'Jestem teraz w pracy.', 'Jestem trochę zmęczony.',
    'Nareszcie wolne.', 'Odpoczywam w domu.', 'Dziś dużo do zrobienia.', 'Słońce świeci, super.', 'Lubię takie dni.');
  out.push(...cross(['Masz ochotę na ', 'Może wyskoczymy na '], ['kawę', 'herbatę', 'spacer', 'obiad', 'krótką rozmowę',
    'wspólny film', 'kawę na mieście', 'coś słodkiego', 'szybki spacer', 'wieczór w kinie', 'lunch', 'małą przerwę'], '?'));
  out.push(...cross(['Chcesz ', 'Może chcesz ', 'Masz ochotę '], ['pogadać', 'zadzwonić', 'się spotkać', 'wyjść na spacer',
    'obejrzeć film', 'wyjść na kawę', 'trochę odpocząć', 'zjeść razem', 'się przejść', 'wpaść później'], '?'));
  out.push(...cross(['Muszę jeszcze ', 'Mam dziś ', 'Chcę jeszcze '], ['popracować', 'zrobić zakupy', 'odpocząć', 'zadzwonić',
    'coś dokończyć', 'ugotować', 'posprzątać', 'się przygotować', 'zrobić kolację', 'załatwić kilka spraw'], '.'));
  out.push(...cross(['Jesteś już ', 'Już '], ['po śniadaniu', 'po obiedzie', 'w domu', 'w pracy', 'wolny', 'zajęty',
    'obudzony', 'po pracy', 'wyspany', 'gotowy'], '?'));
  out.push(...cross(['Jaki ', 'Ale '], ['ładny', 'zimny', 'długi', 'ciepły', 'słoneczny', 'spokojny', 'męczący',
    'przyjemny', 'szary', 'piękny'], ' dzisiaj dzień!'));
  out.push(...cross(['Dzisiaj '], ['jestem trochę zmęczony', 'mam dobry humor', 'dużo do zrobienia', 'nic szczególnego',
    'wszystko spokojnie', 'był długi dzień', 'jest ładny dzień', 'chcę odpocząć', 'pracuję do wieczora', 'mam wolne'], '.'));
  out.push(...cross(['Jak ', 'A jak '], ['praca?', 'nastrój?', 'rodzina?', 'pogoda u was?', 'minął dzień?', 'weekend?', 'nowy projekt?', 'zdrowie?'], ''));
  return out;
};

// ─────────────────────────── ENGLISH (uk = England) ───────────────────────────
const EN = () => {
  const out = [];
  const openers = ['Hi', 'Hey', 'Hello', 'Morning', 'Good evening', 'Hey there', 'Hiya', 'Yo',
    'Hi there', 'Heya', 'Alright', 'Evening'];
  const questions = ['how are you?', 'how’s it going?', 'how have you been?', 'what’s new?', 'what are you up to?',
    'everything okay?', 'how was your day?', 'any plans tonight?', 'have you eaten yet?', 'fancy a coffee?', 'how’s work?', 'what are you doing?',
    'long time no chat, how are you?', 'are you around?', 'still awake?', 'how’s your mood today?', 'anything interesting?', 'how was your weekend?', 'are you home?', 'busy day?',
    'how’s the family?', 'all good?', 'what are you doing tomorrow?', 'any plans for the weekend?', 'already up?', 'how’s the weather there?',
    'how’s everything?', 'what have you got planned?', 'all quiet your side?', 'long time, how’s life?'];
  out.push(...greet(openers, questions));
  out.push('Hi!', 'Good morning!', 'Good afternoon!', 'Good evening!', 'Good night!',
    'Thanks!', 'Thank you so much!', 'You’re welcome.', 'No problem.', 'Sorry for the late reply.',
    'Agreed.', 'Exactly.', 'Interesting.', 'Good idea!', 'Sounds good.',
    'Got it.', 'I see.', 'It’s a deal.', 'Okay, let’s do that.', 'No worries.',
    'See you soon!', 'Take care!', 'Have a nice day!', 'Have a good evening!', 'Look after yourself.',
    'Stay well!', 'I’ll call you later.', 'I’ll message you soon.', 'Good to hear from you.', 'I was thinking about you.',
    'I’m having coffee.', 'Just got up.', 'I haven’t had breakfast yet.', 'I’m at work right now.', 'I’m a bit tired.',
    'Finally, a day off.', 'Just relaxing at home.', 'Lots to do today.', 'The sun is out, lovely.', 'I love days like this.');
  out.push(...cross(['Do you want to ', 'Shall we ', 'How about we ', 'Fancy heading out to '], ['grab a coffee', 'go for a walk',
    'meet up', 'have a call', 'have lunch', 'watch a film', 'step out for a bit', 'do something', 'meet tomorrow', 'catch up', 'sit in a café', 'take a break'], '?'));
  out.push(...cross(['I still need to ', 'I have to ', 'I want to '], ['work', 'do some shopping', 'get some sleep', 'make a call',
    'finish something', 'cook', 'tidy up', 'get ready', 'make dinner', 'sort a few things out'], '.'));
  out.push(...cross(['Have you ', 'Are you '], ['eaten', 'had breakfast', 'awake', 'home', 'at work', 'done with work',
    'free', 'busy', 'rested', 'finished'], ' yet?'));
  out.push(...cross(['What a ', 'Such a '], ['lovely', 'cold', 'long', 'warm', 'sunny', 'quiet', 'tiring', 'pleasant', 'grey', 'beautiful'], ' day today!'));
  out.push(...cross(['Today '], ['I’m a bit tired', 'I’m in a good mood', 'there’s a lot to do', 'nothing much is going on',
    'everything’s calm', 'has been a long day', 'is a nice day', 'I just want to rest', 'I’m working till the evening', 'I’m off'], '.'));
  out.push(...cross(['How’s ', 'And how’s '], ['work?', 'your mood?', 'the family?', 'the weather over there?', 'your day going?', 'your weekend been?', 'the new project?', 'your health?'], ''));
  return out;
};

const LANGS = { ua: UA, de: DE, pl: PL, uk: EN };

function finalize(list) {
  const seen = new Set();
  const uniq = [];
  for (const s of list) { const k = s.trim(); if (k && !seen.has(k)) { seen.add(k); uniq.push(k); } }
  return uniq;
}

let ok = true;
for (const [groupId, gen] of Object.entries(LANGS)) {
  const uniq = finalize(gen());
  if (uniq.length < TARGET) {
    console.error(`[seed] ${groupId}: только ${uniq.length} уникальных (<${TARGET}) — добавьте фраз/фреймов`);
    ok = false;
    continue;
  }
  const lines = uniq.slice(0, TARGET);
  const dir = path.join(ROOT, 'content-seed', groupId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.txt'), lines.join('\n') + '\n');
  console.log(`[seed] ${groupId}: ${uniq.length} уникальных, записано ${lines.length} -> ${path.relative(ROOT, path.join(dir, 'messages.txt'))}`);
}
if (!ok) process.exit(1);
console.log('[seed] готово.');
