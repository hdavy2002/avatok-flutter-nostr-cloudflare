// Categorized emoji set for the emoji tab (STREAM E).
//
// A comprehensive, offline, dependency-free set — enough to fill the WhatsApp
// layout (Recents row + 8 categories + a category icon bar) so the grid looks
// full from day one. Not the entire Unicode set, but several hundred of the
// emojis people actually reach for, ordered roughly by standard keyboard order
// per category. Search matches on category name/id AND on the per-emoji keyword
// map below (`kEmojiKeywords`).
class EmojiCategory {
  final String id;
  final String label;
  final String icon; // the emoji used in the bottom category bar
  final List<String> emojis;
  const EmojiCategory(this.id, this.label, this.icon, this.emojis);
}

const List<EmojiCategory> kEmojiCategories = [
  EmojiCategory('smileys', 'Smileys & People', '😀', [
    // Faces — smiling / happy
    '😀','😃','😄','😁','😆','😅','😂','🤣','🥲','🥹','😊','😇','🙂','🙃','😉',
    '😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓',
    '😎','🥸','🤩','🥳','🙂‍↕️','🙂‍↔️',
    // Faces — neutral / concerned
    '😏','😒','🙄','😬','😮‍💨','🤥','🫨','😌','😔','😪','🤤','😴','😷','🤒','🤕',
    '🤢','🤮','🤧','🥵','🥶','🥴','😵','😵‍💫','🤯','🤠','🥳','🥸','😎','🤓','🧐',
    // Faces — sad / unwell / negative
    '😕','🫤','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰',
    '😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬',
    '😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖',
    // Cat faces & special
    '😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊',
    // Hearts as faces / love
    '😻','💌','💘','💝','💖','💗','💓','💞','💕','💟',
    // Hands & gestures
    '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','🫰','👌','🤌','🤏','✌️','🤞',
    '🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊',
    '🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾',
    // People / body
    '🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','🫦',
    '👶','🧒','👦','👧','🧑','👨','👩','🧓','👴','👵','🧔','👮','🕵️','💂','👷',
    '🤴','👸','👳','👲','🧕','🤵','👰','🤰','🤱','🧑‍🍼','👼','🎅','🤶','🦸','🦹',
    '🧙','🧚','🧛','🧜','🧝','🧞','🧟','💆','💇','🚶','🧍','🧎','🏃','💃','🕺',
    '👯','🧖','🧗','🤺','🏇','⛷️','🏂','🏌️','🏄','🚣','🏊','⛹️','🏋️','🚴','🚵',
    '🤸','🤼','🤽','🤾','🤹','🧘','👫','👬','👭','💑','💏','👪',
  ]),
  EmojiCategory('animals', 'Animals & Nature', '🐶', [
    // Mammals & faces
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽',
    '🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉',
    '🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳',
    '🦟','🦗','🕷️','🕸️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀',
    '🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦣',
    '🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙',
    '🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🐓','🦃','🦤','🦚','🦜','🦢','🦩',
    '🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔',
    // Plants & nature
    '🌵','🎄','🌲','🌳','🌴','🪵','🌱','🌿','☘️','🍀','🎍','🪴','🎋','🍃','🍂',
    '🍁','🍄','🐚','🪨','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝',
    '🌚','🌙','⭐','🌟','✨','⚡','☄️','💫','🔥','🌪️','🌈','☀️','🌤️','⛅','🌥️',
    '☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','💧','💦','🌊',
  ]),
  EmojiCategory('food', 'Food & Drink', '🍔', [
    // Fruit
    '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍',
    '🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅',
    '🥔','🍠','🫘','🥜','🌰',
    // Prepared / carbs
    '🍞','🥐','🥖','🫓','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟',
    '🍕','🌭','🥪','🌮','🌯','🫔','🥙','🧆','🥚','🍳','🥘','🍲','🫕','🥣','🥗',
    '🍿','🧈','🧂','🥫',
    // Asian & seafood
    '🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟',
    '🥠','🥡','🦪',
    // Sweets & desserts
    '🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯',
    // Drinks
    '🍼','🥛','☕','🫖','🍵','🍶','🍾','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🥤',
    '🧋','🧃','🧉','🧊','🥢','🍽️','🍴','🥄',
  ]),
  EmojiCategory('activities', 'Activities', '⚽', [
    // Sports
    '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑',
    '🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷',
    '⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🤾','🏌️','🏇','🧘',
    // Awards & tickets
    '🏆','🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️',
    // Arts & performance
    '🎪','🤹','🎭','🩰','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗',
    '🎸','🪕','🎻',
    // Games
    '🎲','♟️','🎯','🎳','🎮','🕹️','🎰','🧩','🪆',
    // Celebration
    '🎉','🎊','🎈','🎁','🎀','🪅','🎏','🎐','🎎','🧧','🎆','🎇','🧨','✨','🎄',
    '🎃','🎋','🎍','🎑','🎓',
  ]),
  EmojiCategory('travel', 'Travel & Places', '✈️', [
    // Road vehicles
    '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🦯',
    '🦽','🦼','🛴','🚲','🛵','🏍️','🛺','🚨','🚔','🚍','🚘','🚖','🚡','🚠','🚟',
    '🚃','🚋','🚞','🚝','🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉',
    // Air & sea
    '✈️','🛫','🛬','🛩️','💺','🛰️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️',
    '🚢','⚓','🪝','⛽','🚧','🚦','🚥','🗺️','🗿','🗽','🗼','🏰','🏯','🏟️','🎡',
    '🎢','🎠','⛲','⛱️','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻','🏕️','⛺','🛖',
    // Buildings & places
    '🏠','🏡','🏘️','🏚️','🏗️','🏭','🏢','🏬','🏣','🏤','🏥','🏦','🏨','🏪','🏫',
    '🏩','💒','🏛️','⛪','🕌','🕍','🛕','🕋','⛩️','🛤️','🛣️','🗾','🎑','🏞️','🌅',
    '🌄','🌠','🎇','🎆','🌇','🌆','🏙️','🌃','🌌','🌉','🌁',
  ]),
  EmojiCategory('objects', 'Objects', '💡', [
    // Tech
    '⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀',
    '📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️',
    '🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️',
    // Home & tools
    '🪔','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','🧾','💎','⚖️','🪜',
    '🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🪤','🧲','🔫','💣','🧨',
    '🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','💈','⚗️',
    '🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🧺',
    // Household & personal
    '🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪥','🪒','🧴','🛎️','🔑','🗝️','🚪','🪑',
    '🛋️','🛏️','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅',
    // Stationery & mail
    '📩','📨','📧','💌','📥','📤','📦','🏷️','📪','📫','📬','📭','📮','📯','📜',
    '📃','📄','📑','📊','📈','📉','🗒️','🗓️','📆','📅','🗑️','📇','🗃️','🗳️','🗄️',
    '📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖',
    '🔖','🧷','🔗','📎','🖇️','📐','📏','🧮','📌','📍','✂️','🖊️','🖋️','✒️','🖌️',
    '🖍️','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓',
  ]),
  EmojiCategory('symbols', 'Symbols', '❤️', [
    // Hearts & love
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','❤️‍🩹','💔','❣️','💕','💞',
    '💓','💗','💖','💘','💝','💟','💌',
    // Religion & belief
    '☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎',
    // Zodiac
    '♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓',
    // Signs & warnings
    '🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮',
    '🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕',
    '🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗',
    '❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅',
    '🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🛗',
    // Arrows & UI
    '🚹','🚺','🚼','⚧️','🚻','🈳','🛂','🛃','🛄','🛅','🚸','⬆️','↗️','➡️','↘️',
    '⬇️','↙️','⬅️','↖️','↕️','↔️','↩️','↪️','⤴️','⤵️','🔃','🔄','🔙','🔚','🔛',
    '🔜','🔝','🔀','🔁','🔂','▶️','⏸️','⏯️','⏹️','⏺️','⏭️','⏮️','⏩','⏪','⏫',
    '⏬','◀️','🔼','🔽','➕','➖','➗','✖️','🟰','♾️','💲','💱','™️','©️','®️',
    '👁️‍🗨️','🔚','〰️','➰','➿','🔘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤',
    '🔺','🔻','🔸','🔹','🔶','🔷','🔳','🔲','▪️','▫️','◾','◽','◼️','◻️','⬛',
    '⬜','🟥','🟧','🟨','🟩','🟦','🟪','🟫','🔈','🔇','🔉','🔊','🔔','🔕','📣',
    '📢','🎵','🎶','💬','💭','🗯️','♠️','♣️','♥️','♦️','🃏','🎴','🀄',
  ]),
  EmojiCategory('flags', 'Flags', '🏳️', [
    // Generic
    '🏳️','🏴','🏁','🚩','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇺🇳',
    // Popular / large countries
    '🇺🇸','🇬🇧','🇨🇦','🇦🇺','🇳🇿','🇮🇪','🇮🇳','🇵🇰','🇧🇩','🇱🇰','🇳🇵','🇨🇳',
    '🇯🇵','🇰🇷','🇰🇵','🇹🇼','🇭🇰','🇸🇬','🇲🇾','🇮🇩','🇵🇭','🇹🇭','🇻🇳','🇲🇲',
    '🇰🇭','🇱🇦',
    // Europe
    '🇫🇷','🇩🇪','🇮🇹','🇪🇸','🇵🇹','🇳🇱','🇧🇪','🇨🇭','🇦🇹','🇸🇪','🇳🇴','🇩🇰',
    '🇫🇮','🇮🇸','🇵🇱','🇨🇿','🇸🇰','🇭🇺','🇷🇴','🇧🇬','🇬🇷','🇭🇷','🇷🇸','🇺🇦',
    '🇷🇺','🇧🇾','🇱🇹','🇱🇻','🇪🇪','🇱🇺','🇲🇹','🇨🇾',
    // Middle East
    '🇸🇦','🇦🇪','🇶🇦','🇰🇼','🇧🇭','🇴🇲','🇯🇴','🇱🇧','🇮🇱','🇵🇸','🇹🇷','🇮🇷',
    '🇮🇶','🇸🇾','🇾🇪','🇦🇫',
    // Africa
    '🇳🇬','🇿🇦','🇰🇪','🇬🇭','🇪🇬','🇪🇹','🇹🇿','🇺🇬','🇩🇿','🇲🇦','🇹🇳','🇸🇳',
    '🇨🇮','🇨🇲','🇦🇴','🇲🇿','🇿🇲','🇿🇼','🇧🇼','🇳🇦','🇷🇼','🇸🇴','🇸🇩','🇱🇾',
    // Americas
    '🇧🇷','🇲🇽','🇦🇷','🇨🇱','🇨🇴','🇵🇪','🇻🇪','🇪🇨','🇧🇴','🇵🇾','🇺🇾','🇨🇺',
    '🇩🇴','🇯🇲','🇭🇹','🇬🇹','🇨🇷','🇵🇦','🇧🇸','🇹🇹',
  ]),
];

/// Per-emoji keyword map for search. Keys are emoji chars, values are a
/// space-separated list of search terms. This is ADDITIVE: search still falls
/// back to matching a category's name/id, so unmapped emojis remain searchable
/// via their category. Only the most commonly-searched emojis are mapped.
const Map<String, String> kEmojiKeywords = {
  '😀': 'grin happy smile face',
  '😃': 'happy smile joy face',
  '😄': 'happy smile laugh grin',
  '😁': 'grin beaming smile teeth',
  '😆': 'laugh haha lol grin',
  '😅': 'sweat laugh nervous relief',
  '😂': 'joy laugh cry lol funny tears',
  '🤣': 'rofl rolling laughing lol funny',
  '🥲': 'smile tear happy sad',
  '😊': 'blush smile happy warm',
  '😇': 'angel innocent halo',
  '🙂': 'slight smile',
  '🙃': 'upside down silly',
  '😉': 'wink flirt',
  '😌': 'relieved calm content',
  '😍': 'love heart eyes crush adore',
  '🥰': 'love hearts adore smile',
  '😘': 'kiss blow love',
  '😋': 'yum tasty tongue delicious',
  '😜': 'wink tongue playful',
  '🤪': 'crazy silly zany goofy',
  '😎': 'cool sunglasses swag',
  '🥳': 'party celebrate hooray birthday',
  '🤩': 'star struck excited amazed wow',
  '😏': 'smirk sly',
  '😒': 'unamused meh annoyed',
  '🙄': 'eye roll whatever',
  '😔': 'sad pensive down',
  '😢': 'cry sad tear',
  '😭': 'sob cry bawl sad tears',
  '😤': 'huff angry frustrated triumph',
  '😠': 'angry mad',
  '😡': 'rage angry mad furious',
  '🤬': 'swear curse angry mad',
  '😱': 'scream fear shock scared',
  '😨': 'fear scared anxious',
  '😰': 'anxious sweat nervous scared',
  '😥': 'sad disappointed relieved',
  '🥺': 'pleading puppy eyes beg cute',
  '😴': 'sleep zzz tired',
  '😪': 'sleepy tired',
  '🤤': 'drool want desire',
  '😷': 'mask sick ill',
  '🤒': 'sick fever ill thermometer',
  '🤢': 'nausea sick gross yuck',
  '🤮': 'vomit sick puke gross',
  '🥵': 'hot heat sweat',
  '🥶': 'cold freeze frozen',
  '🤯': 'mind blown shock explode wow',
  '😵': 'dizzy dead knocked out',
  '🤠': 'cowboy hat',
  '🤡': 'clown creepy',
  '💀': 'skull dead dying lol',
  '👻': 'ghost boo spooky halloween',
  '👽': 'alien ufo',
  '🤖': 'robot bot ai',
  '💩': 'poop poo crap funny',
  '👋': 'wave hi hello bye',
  '👌': 'ok okay perfect nice',
  '✌️': 'peace victory two',
  '🤞': 'fingers crossed luck hope',
  '🤟': 'love you ily rock',
  '🤙': 'call me hang loose shaka',
  '👍': 'thumbs up like yes good approve',
  '👎': 'thumbs down dislike no bad',
  '✊': 'fist raised power solidarity',
  '👊': 'fist bump punch',
  '👏': 'clap applause bravo',
  '🙌': 'raise hands celebrate praise hooray',
  '🙏': 'pray thanks please hope namaste',
  '🫶': 'heart hands love',
  '🤝': 'handshake deal agree',
  '💪': 'muscle strong flex gym',
  '❤️': 'heart love red',
  '🧡': 'orange heart love',
  '💛': 'yellow heart love',
  '💚': 'green heart love',
  '💙': 'blue heart love',
  '💜': 'purple heart love',
  '🖤': 'black heart love',
  '🤍': 'white heart love',
  '💔': 'broken heart heartbreak sad',
  '💕': 'two hearts love',
  '💖': 'sparkle heart love',
  '💯': 'hundred perfect score 100',
  '🔥': 'fire lit hot flame',
  '✨': 'sparkles shine magic',
  '⭐': 'star favorite',
  '🎉': 'party celebrate tada congrats',
  '🎊': 'confetti party celebrate',
  '🎈': 'balloon party birthday',
  '🎁': 'gift present birthday',
  '🎂': 'cake birthday',
  '🐶': 'dog puppy pet',
  '🐱': 'cat kitten pet',
  '🦊': 'fox',
  '🐻': 'bear',
  '🐼': 'panda',
  '🦁': 'lion',
  '🐷': 'pig',
  '🐸': 'frog',
  '🐵': 'monkey',
  '🦄': 'unicorn magic',
  '🐝': 'bee honey',
  '🦋': 'butterfly',
  '🐢': 'turtle slow',
  '🐍': 'snake',
  '🐙': 'octopus',
  '🐟': 'fish',
  '🐬': 'dolphin',
  '🐳': 'whale ocean',
  '🌸': 'blossom flower cherry pink',
  '🌹': 'rose flower love',
  '🌻': 'sunflower flower',
  '🌈': 'rainbow pride colorful',
  '☀️': 'sun sunny weather',
  '🌙': 'moon night',
  '❄️': 'snow snowflake cold winter',
  '🍎': 'apple fruit red',
  '🍌': 'banana fruit',
  '🍓': 'strawberry fruit',
  '🍕': 'pizza food',
  '🍔': 'burger hamburger food',
  '🍟': 'fries food',
  '🌮': 'taco food mexican',
  '🍜': 'noodles ramen food',
  '🍣': 'sushi food japanese',
  '🍦': 'ice cream dessert',
  '🍩': 'donut doughnut dessert',
  '🍪': 'cookie dessert',
  '🍫': 'chocolate sweet',
  '☕': 'coffee tea drink hot',
  '🍺': 'beer drink',
  '🍷': 'wine drink',
  '🍸': 'cocktail drink martini',
  '⚽': 'soccer football sport ball',
  '🏀': 'basketball sport ball',
  '🏈': 'football sport ball american',
  '⚾': 'baseball sport ball',
  '🎾': 'tennis sport ball',
  '🏆': 'trophy win champion award',
  '🥇': 'gold medal first win',
  '🎮': 'game gaming controller video',
  '🎸': 'guitar music rock',
  '🎤': 'mic microphone sing karaoke',
  '🎧': 'headphones music listen',
  '🚗': 'car auto drive',
  '✈️': 'plane airplane flight travel fly',
  '🚀': 'rocket space launch',
  '🚢': 'ship boat cruise',
  '🏠': 'house home',
  '🏥': 'hospital',
  '🗽': 'statue liberty new york usa',
  '🌍': 'earth world globe',
  '📱': 'phone mobile cell smartphone',
  '💻': 'laptop computer',
  '💡': 'idea light bulb',
  '💰': 'money bag cash rich',
  '💵': 'money dollar cash',
  '💳': 'card credit pay',
  '🎁': 'gift present',
  '🔑': 'key lock unlock',
  '🔒': 'lock secure private',
  '📷': 'camera photo picture',
  '🔔': 'bell notification alert',
  '✅': 'check tick yes done correct',
  '❌': 'cross x no wrong cancel',
  '❓': 'question mark',
  '❗': 'exclamation important warning',
  '⚠️': 'warning caution alert',
  '🚫': 'no ban forbidden stop',
  '💬': 'speech chat message bubble talk',
  '🎵': 'music note song',
};

/// Flat keyword search across all categories. Returns matching emoji chars.
///
/// Matching (unchanged signature, backward compatible):
///  1. Any emoji whose keyword string (kEmojiKeywords) contains the needle.
///  2. Every emoji in a category whose label/id contains the needle (original
///     behavior — so "food", "flags", "animals" etc. still return the whole set).
/// Results are de-duplicated while preserving order.
List<String> searchEmoji(String q) {
  final needle = q.trim().toLowerCase();
  if (needle.isEmpty) return const [];
  final out = <String>[];
  // 1) Per-emoji keyword hits first (most relevant).
  kEmojiKeywords.forEach((emoji, kw) {
    if (kw.contains(needle)) out.add(emoji);
  });
  // 2) Category-name / id hits (original behavior).
  for (final c in kEmojiCategories) {
    if (c.label.toLowerCase().contains(needle) || c.id.contains(needle)) {
      out.addAll(c.emojis);
    }
  }
  return out.toSet().toList();
}
