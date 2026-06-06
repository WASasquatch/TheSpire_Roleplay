/**
 * Default worlds shipped on every install. The system user owns them all so
 * they survive admin churn. Visibility is "open" so they appear in the World
 * Catalog and any user can join them or attach them to rooms.
 *
 * Versioning: bump WORLDS_SEED_VERSION whenever the content below ships
 * meaningful changes. On boot the seeder compares against
 * site_settings.worlds_seed_version and OVERWRITES all system-owned worlds
 * (name, description, pages) when the constant is higher. World ids
 * survive the overwrite so existing world memberships, room links, and
 * primary-world references all stay intact across content updates.
 *
 * Admins who customized a system world and don't want it overwritten:
 * clone the world to your own ownership (the refresh only ever touches
 * owner = "system") or rename the system copy out of the way.
 *
 * The seeder still gracefully handles missing worlds (renamed defaults,
 * fresh installs) by re-inserting them regardless of version, so new
 * additions to this list always show up on the next boot too.
 */

/**
 * Iteration of the default-worlds content. Bump on every shipped content
 * refresh. Each bump triggers a one-time overwrite of system worlds on
 * next boot. Skip a bump if changes are seed-mechanic only (e.g.
 * refactoring this file's helpers).
 */
export const WORLDS_SEED_VERSION = 3;

export interface SeedPage {
  /** Page slug (must match SLUG_RX in routes/worlds.ts). */
  slug: string;
  title: string;
  bodyHtml: string;
}

export interface SeedWorld {
  slug: string;
  name: string;
  description: string;
  pages: SeedPage[];
  /**
   * Catalog metadata (Phase 1 of the worlds/DMs plan). All optional,
   * the seed loader fills in defaults (`genre: "other"`, empty
   * tags/CWs, `pacing: null`) for any world that hasn't been
   * classified yet. Existing values get overwritten on every seed
   * version bump, so editing this file is the source of truth for
   * default-world classification.
   */
  genre?:
    | "fantasy" | "modern" | "scifi" | "horror"
    | "western" | "steampunk" | "mythological" | "other";
  tags?: ReadonlyArray<string>;
  contentWarnings?: ReadonlyArray<string>;
  pacing?: "freeform" | "drop-in" | "casual" | "slice-of-life" | "structured" | "long-form" | null;
}

const p = (slug: string, title: string, bodyHtml: string): SeedPage => ({ slug, title, bodyHtml });

// Common five-section structure for every world. Same slugs across the
// catalog so a returning user always knows where to look:
//   background, overview, history, current state
//   npcs      , named NPCs to interact with or hear about
//   places    , towns, regions, landmarks
//   lore      , myths, cosmology, deep history, ongoing mysteries
//   rules     , tone, RP style, what's allowed, what's not
const bg = (html: string) => p("background", "Background", html);
const npcs = (html: string) => p("npcs", "Major NPCs", html);
const places = (html: string) => p("places", "Towns & Places", html);
const lore = (html: string) => p("lore", "Lore", html);
const rules = (html: string) => p("rules", "World Rules", html);

export const DEFAULT_WORLDS: SeedWorld[] = [
  /* ============================================================
   *  Medieval & High Fantasy
   * ============================================================ */
  {
    slug: "ironreach",
    name: "Ironreach",
    description: "A high-fantasy kingdom of granite holds, dragon-scarred valleys, and oaths older than the throne.",
    pages: [
      bg(`<p>Ironreach is a mountainous kingdom whose people remember every promise. The <b>High Hold</b> sits atop a cliff that drinks the wind, and from there the Iron Crown rules five lesser holds bound by the <b>Old Oath</b>, a compact carved into the mountain's roots, said to crack if ever broken.</p>
<p>Three centuries ago the Dragon Wars scoured the southern valleys. The land remembers: glassed cliffs, valleys where no tree grows past waist-height, bones the size of granaries half-buried in the scree. Veterans of that war became the first Wardens; their order survives.</p>
<p>The kingdom is at peace, mostly. The Wildwood Tribes press on the western border. The merchants of Eldermere argue with the smiths of Blackvein over toll roads. The Greysend hold has not sent a representative to the High Throne in eleven months. The current ruler, <b>Queen Sennach Maerwyn, fourteenth of her line</b>, does not yet seem worried, which means either she isn't or she is very good at hiding it.</p>
<p>Magic is rare. The Wardens read the old runes and can wake a stone, mend a wound, or, very occasionally, kill from a distance. Common folk treat them with the same caution one offers an old, calm wolf.</p>`),
      npcs(`<p>Figures who matter, by name and by reputation:</p>
<ul>
<li><b>Queen Sennach Maerwyn</b>, Iron-Crowned, fifty-three winters, widowed twice. Pragmatic. Reads three reports before breakfast and remembers them all. Her tolerance for fools is low and her memory for slights is generational.</li>
<li><b>Warden-Mother Aelis Korr</b>, head of the Order of Stoneward Wardens. Quiet, austere, walks with a staff carved from a dragon's rib. Has refused court appointment four times.</li>
<li><b>Lord Vorrik of Blackvein</b>, youngest of the hold-lords, ambitious to the point of recklessness. Recently funded the rebuilding of three border watchtowers without asking the Crown. Either generous or strategic; nobody is sure which.</li>
<li><b>Captain Hawk Iron-Hand</b>, commander of the Stonewatch garrison. Veteran of two minor border skirmishes. Honest to the point of bluntness; the most-requested commander for dangerous postings, and the least-promoted.</li>
<li><b>The Recluse of Greysend</b>, referred to in correspondence only by title. Has held the Greysend seat for four decades. The Crown's last three envoys returned with vague reports and an obvious reluctance to return.</li>
</ul>`),
      places(`<p>The five holds answer to the High Throne but govern their own valleys.</p>
<ul>
<li><b>The High Hold</b>, the capital. A black-stone fortress on a wind-blasted cliff. The throne room's floor is the Old Oath itself, inlaid in silver runes the Wardens renew every solstice.</li>
<li><b>Stonewatch</b>, the war-hold. Keeps the southern pass and the road into the dragon-scarred valleys. Garrison town of two thousand; everyone has a relative who's served.</li>
<li><b>Eldermere</b>, lake-country, the politically restless one. Old families, deep wine cellars, longer memories than the Crown likes. Trade with the merchant principalities across the Sundering Sea runs through here.</li>
<li><b>Blackvein</b>, mining hold. Iron, silver, the rare dark ore the Wardens use for binding-work. A town of furnaces and lung-rot.</li>
<li><b>Thornhall</b>, forested borderland with the Wildwood Tribes. The Hold-Lord is half-Wildwood by blood; this is a constant low-grade scandal at court.</li>
<li><b>Greysend</b>, the cold, distant hold. Glacier-edge country, half-empty villages, a fortress everyone agrees is older than the kingdom. Rumored heresies; no Warden has been admitted in twelve years.</li>
</ul>`),
      lore(`<p><b>The Old Oath.</b> Written into the floor of the throne room and into the bedrock beneath every hold-keep. Says the five holds shall stand together, give each other passage and grain in lean years, and refuse no Warden their bread. Said to crack, literally, in the stone, if ever broken. The Wardens claim the floor of the High Hold has hairline fissures that didn't exist a year ago.</p>
<p><b>The Dragon Wars.</b> Three hundred years past. The kingdom was four holds then; the fifth (Stonewatch) was founded by veterans afterward. Most of what's known comes from Warden archives. The bones are real. The fact that there have been no confirmed dragon sightings in two and a half centuries is either a victory or a held breath.</p>
<p><b>The Wardens.</b> Recruited young, trained in seclusion at the Roothold deep under the High Hold. Read the runes carved into mountain roots, a script said to predate human settlement. They are not priests. They serve the Oath, not the Crown.</p>`),
      rules(`<p>Tone: hard-edged classic fantasy. Loyalty, oath-bonds, the weight of inherited duty.</p>
<ul>
<li><b>Low magic.</b> A Warden's spell is an event, not a casual flourish. Player magic is rare and costly; cleric/druid/ranger-style nature work is more common than ceremonial-mage flash.</li>
<li><b>Politics is local.</b> Most stories unfold within or between holds. The High Throne is a constant pressure, not a daily presence.</li>
<li><b>Oath-breaking is the worst sin.</b> Even villains keep their word; they choose carefully whom they word it to.</li>
<li><b>Combat is meaningful.</b> Death isn't trivial. Recovery from wounds takes time. Resurrection is not a thing.</li>
<li>Good fits: knightly RP, court intrigue, frontier patrols, family sagas, Warden-novice training arcs.</li>
</ul>`),
    ],
    genre: "fantasy",
    tags: ["low-magic", "courtly", "political"],
    contentWarnings: ["violence"],
    pacing: "structured",
  },

  {
    slug: "vesperhold",
    name: "Vesperhold",
    description: "A walled city-state ringed by haunted moors. The bells chime three times when the dead are restless.",
    pages: [
      bg(`<p>Vesperhold is a walled city-state at the edge of the <b>Pale Moor</b>. Long ago, when the first wall went up, the city made an unspoken bargain with what lives in the mist: keep the bells rung, the lanterns lit, the gates barred from dusk to dawn, and the things in the moor will mostly leave you alone.</p>
<p>Mostly.</p>
<p>Inside the wall the city looks ordinary enough, slate roofs, three market squares, a guildhall, a university with bad coffee. Outside the wall, after the carriage roads thin to footpaths, the moor swallows everything. Cairns rise from the heather without anyone having placed them. Lights drift between them at dusk. Travelers who walk the wrong path go missing in ways no investigator has solved.</p>
<p>The city is governed by the <b>Council of Five</b> from the Lantern Spire: two merchants, two generals (one retired), and the High Lantern, a priest of an older sect who never speaks unless the Council is deadlocked. The Council deadlocks often.</p>`),
      npcs(`<ul>
<li><b>High Lantern Veris Aimon</b>, the priest on the Council. Eighty years old, scarred, blind in one eye. Walks the wall every dusk and lights the first lantern personally. Refuses guards.</li>
<li><b>Merchant-Speaker Halis Wren</b>, head of the merchants' bloc. Smiling, well-tailored, controls the salt and lantern-oil trades. Three of her ships are unaccounted for.</li>
<li><b>General Olek Marvis (ret.)</b>, bell-master of the western quarter. Knows by ear when a bell is mistimed. Has rung the three-chime warning twice in his life and is unwilling to talk about either.</li>
<li><b>Saela of the Path</b>, wandering hedge-witch tolerated within the walls. The only person in the city who walks freely on the moor by night. Charges, in favors rather than coin.</li>
<li><b>The Quiet Man</b>, appears at the lantern district approximately twice a year, asks a single question of a single person, and leaves. The questions, when reported, are never the same. Nobody knows where he lives.</li>
</ul>`),
      places(`<ul>
<li><b>The Lantern Spire</b>, civic heart, central tower, council chamber at the top, the city's master bell at its peak. The first lantern of the night is lit here.</li>
<li><b>The Old Cathedral</b>, the High Lantern's seat. Bigger than the city's current faith demands. Crypts beneath are sealed; the keys are individually held by five Council members.</li>
<li><b>The Moor-Quarter</b>, neighborhood pressed against the western wall. House prices are suspiciously low. Mist comes through the masonry on bad nights.</li>
<li><b>The Pale Moor</b>, wilderness ringing the city. Peat, heather, mist, and cairns. The Pale Folk live (or whatever the right verb is) somewhere out in it. Daylight crossings are routine; night crossings are how people go missing.</li>
<li><b>Wickwell</b>, closest village on the moor's far side. Two days' walk in good weather, two weeks if the paths shift. The villagers and the city haven't seen each other for three months.</li>
</ul>`),
      lore(`<p><b>The Bells.</b> Three bells in the city: the great bell at the Spire, the western bell (General Marvis's domain), and the river bell. They ring on a precise schedule. Three chimes out of pattern means the dead are restless and the gates do not open until dawn, for any reason, ever, on penalty of expulsion.</p>
<p><b>The Pale Folk.</b> Old residents of the moor. Not hostile. Not friendly. They are <i>elsewhere</i>, their paths are not the paths walked by the living, and a traveler who steps onto one becomes hard to find again. They are aware of the city. They have been respectful of the wall for centuries. Whether they always will be is a question for council, not a settled matter.</p>
<p><b>The Concord.</b> The pact between the founders of Vesperhold and the moor. Never written down; passed orally from High Lantern to High Lantern. The current High Lantern is the seventh to bear the office. The fifth is rumored to have broken some clause, and the Old Cathedral's crypts were sealed shortly after.</p>`),
      rules(`<p>Tone: quiet, eerie, slow-burn folk horror with civic backbone.</p>
<ul>
<li><b>Magic is borrowed, not commanded.</b> Hedge-witches like Saela work in favors and old courtesies, not raw force. Player witches negotiate; they do not blast.</li>
<li><b>The wall matters.</b> Going outside at night is a choice, and a serious one. Stories of <i>missing</i> outweigh stories of <i>killed</i>.</li>
<li><b>Civic stakes.</b> Council politics, guild squabbles, and bell schedules are as important as the supernatural. Both layers should appear.</li>
<li><b>The Pale Folk are not enemies.</b> They're a different country. Hostility is a failure state, not a default.</li>
<li>Good fits: investigators, scholars, priests, merchants with secrets, expatriates who came here to disappear.</li>
</ul>`),
    ],
    genre: "horror",
    tags: ["mystery", "investigation", "urban"],
    contentWarnings: ["dark-themes", "death"],
    pacing: "structured",
  },

  {
    slug: "thrice-crowned",
    name: "The Thrice-Crowned Realm",
    description: "Three rival kingdoms, one prophesied throne, and a hundred years of cold war waiting to thaw.",
    pages: [
      bg(`<p>Centuries ago, a single empire splintered into three crowns. The <b>Sundering</b> was a war so destructive that the three successor kingdoms, <b>Aldermark</b>, <b>Vermillion</b>, and <b>Sunhollow</b>, signed the <b>Cold Compact</b> at Whitewater and have, for a hundred years, refused to fight each other openly.</p>
<p>The prophecy says one crown will reunite the realm. Every court has its preferred reading of which crown that means. Diplomats trade smiles. Spies do not stop. Borders are formally open and informally watched. The next Whitewater Conference is in two springs; the Compact comes up for re-ratification then.</p>
<p>Religion is split: Aldermark venerates the law-giver god Tessar; Vermillion the warrior-pair Vael and Marrod; Sunhollow the silent god Lhain, who is said to have left the world but to listen still. The Sunhollow mage-academies are the most feared institution on the continent. Aldermark's lawyers are a close second.</p>`),
      npcs(`<ul>
<li><b>King-Speaker Caen Olerys of Aldermark</b>, elected by the Assembly, currently in his second seven-year term. Lawyer by training, merchant by family. Speaks slowly and listens longer.</li>
<li><b>High Queen Idryn the Vermillion</b>, sixth of her name. Crowned at sixteen, now forty-one. Fought a war of accession at twenty-two. Has not lost a tournament joust in six years.</li>
<li><b>Archmagus Selven of Sunhollow</b>, head of the Three Towers. Reclusive; appears in person perhaps twice a year. His apprentices fear him; his peers admire him; nobody likes him.</li>
<li><b>Lady Hesper Vance</b>, Vermillion ambassador to Aldermark. Famous duelist, infamous flirt, possibly a spy. The Aldermark court loves her in the careful way one loves a beautiful blade.</li>
<li><b>The Speaker of the Empty Throne</b>, Sunhollow institution. A mage tasked with maintaining the empty hall where the unified empire's throne sat. Currently held by a woman in her thirties whose name is not used in official correspondence.</li>
</ul>`),
      places(`<ul>
<li><b>Whitewater</b>, neutral city on the three-borders triangle. Site of the Compact. Hosts the diplomatic quarter where all three crowns maintain embassies. The single law here is the Concordant Code, enforced by a small mixed garrison.</li>
<li><b>Aldermark City</b>, sprawling merchant capital. The Assembly meets in the Grand Hall; the Speaker's House sits on the river. Famous for its libraries and its lawyers and its fog.</li>
<li><b>Vermillion's High Keep</b>, fortress-capital, red-stone, terraced. The tournament grounds outside the walls host the Crown Tourney every fifth year. The next is in three.</li>
<li><b>The Three Towers, Sunhollow</b>, the academy. Each tower is a discipline (Binding, Reading, Speaking). Apprentices enter at twelve and rarely leave the precincts before twenty.</li>
<li><b>The Empty Hall</b>, preserved as it was the day the empire ended. Sunhollow guards it. The throne is missing. No record agrees on when it was taken.</li>
</ul>`),
      lore(`<p><b>The Sundering.</b> Three centuries past, the unified empire fractured in a single year. The official histories differ by court. What is agreed: the Empress died without an heir, three claimants emerged, the war lasted twenty-one years, and the throne, the actual physical throne, disappeared on the last day.</p>
<p><b>The Prophecy of Restoration.</b> "When the three crowns kneel as one, the throne shall return." Every court interprets this differently. Aldermark reads it as legal unification. Vermillion reads it as conquest. Sunhollow reads it as something more literal and less comfortable to discuss in foreign company.</p>
<p><b>The Cold Compact.</b> The non-aggression treaty signed at Whitewater. Bans open war between the three crowns and any direct alliance against the other two. Has been violated in spirit dozens of times; in letter, never. Re-ratification every century is a formality. The upcoming one is the third.</p>`),
      rules(`<p>Tone: political fantasy. Diplomacy on the surface, daggers underneath.</p>
<ul>
<li><b>Pick a court</b>, players generally hold an allegiance (Aldermark, Vermillion, Sunhollow), are pointedly between courts (Whitewater factor), or are foreign. "No allegiance at all" is harder than it looks; the courts will assign you one regardless.</li>
<li><b>Magic exists, and it's regulated.</b> Sunhollow mages are the gold standard. Aldermark licenses theirs heavily. Vermillion's are usually disguised as priests of Vael.</li>
<li><b>Open warfare is a player-side red line.</b> Cold war, proxies, espionage, duels, yes. Pitched battles between the crowns, out of scope.</li>
<li>Good fits: ambassadors, spies, duelists, mage apprentices, courtiers, merchants with too many loyalties.</li>
</ul>`),
    ],
    genre: "fantasy",
    tags: ["intrigue", "political", "courtly", "war"],
    contentWarnings: ["violence"],
    pacing: "structured",
  },

  {
    slug: "wildemere",
    name: "Wildemere",
    description: "A frontier of green wilderness, druid-circles, and small holds scratched out between standing stones.",
    pages: [
      bg(`<p>Wildemere is what was once forgotten wilderness, now slowly settling. The <b>Druid Circles</b> still hold the largest patches of old forest under their warded peace. Humans, half-folk, and stranger settlers carve small holds out of the in-between, clearings, river-bends, the protective lee of standing stones. There is no king. There is the <b>Moot</b>: an annual gathering at Standing Hollow where the holds, the circles, and the wandering folk argue about who owes whom what.</p>
<p>The land remembers the older powers. Stone circles sit on hills no farmer plows. The names of certain streams are not used after dark, and the locals will explain why if you ask politely. The Circles do not call themselves law, but they are the closest thing to one, and they are not above settling a hold's mistakes with a quiet word, or in the worst case, a fire.</p>
<p>This year's Moot is unusual: the Hawthorn and Thornroot Circles, silent toward each other for nineteen years, have both indicated they will attend.</p>`),
      npcs(`<ul>
<li><b>Mother Briar of Hawthorn Circle</b>, eldest of the active druids, well past seventy. Walks barefoot in any weather. Has never been seen to lose her temper, which is considered slightly more frightening than the alternative.</li>
<li><b>Hael of Thornroot</b>, youngest circle-head, mid-thirties. Took up the title eight years ago after the previous one died on a Solstice nobody discusses. Has not spoken to a Hawthorn druid since.</li>
<li><b>Reeve Coll of Stonebrook Hold</b>, pragmatic farmer-turned-administrator. Speaks for the largest of the human holds. Will sell you out for the hold's benefit; he's told you that to your face.</li>
<li><b>The Hawker</b>, wandering bard and rumor-merchant. Travels the holds in a green cloak. Knows three things you don't and will trade two of them.</li>
<li><b>The Standing of Standing Hollow</b>, not exactly a person. A presence that holds court at the central stone during the Moot. Speaks through whichever druid is steadiest. Has not been wrong yet.</li>
</ul>`),
      places(`<ul>
<li><b>Standing Hollow</b>, site of the Moot. A natural amphitheater ringed by twelve standing stones. The grass within the ring is greener than anywhere outside it.</li>
<li><b>Stonebrook Hold</b>, the largest human settlement, three hundred souls. Walled, gated, sensibly placed near a fording-stone. Hosts the off-Moot markets every third moon.</li>
<li><b>The Briar</b>, Hawthorn Circle's domain. Dense thorn-forest at the foot of the western hills. Pathways shift; uninvited travelers wander.</li>
<li><b>The Long Mire</b>, Thornroot's territory. Bog country, ringed by deadfalls. Visitors do not enter without a Thornroot guide. Some don't come out even with one.</li>
<li><b>The Wandering Holds</b>, half a dozen small settlements that move every few years for reasons their inhabitants find difficult to explain.</li>
</ul>`),
      lore(`<p><b>The Circles.</b> Five active druid-circles: Hawthorn, Thornroot, Whitebloom, Stonethroat, and Quietwater. They wardenly the wild and answer to no Crown. Internal politics are intense; the silence between Hawthorn and Thornroot is the longest-standing.</p>
<p><b>The Nineteen-Year Silence.</b> Something happened at the Solstice of Three Moons, nineteen years ago. Both Hawthorn and Thornroot were present. Neither has spoken to the other since. The other circles know more than they admit; the holds know less than they pretend.</p>
<p><b>The Standing.</b> Older than the circles. Older, possibly, than humans on this land. Speaks at the Moot, through a chosen mouthpiece. Its judgments are binding because nobody has ever survived disregarding one.</p>`),
      rules(`<p>Tone: green frontier fantasy. Slow seasons, lived-in wilderness, the politics of small communities.</p>
<ul>
<li><b>The land is awake.</b> Wards, omens, and small accordances with stream and stone are part of daily life. Even non-druids know which stile not to climb on a feast night.</li>
<li><b>Druidic magic is real but rooted.</b> Circle-druids work in slow cycles, oaths, and stewardship, not battlefield blasts. Player druids should align with this register.</li>
<li><b>Settler vs. settled.</b> New holds expanding into wild country is a constant source of conflict. Both sides have a point.</li>
<li><b>The Moot is sacred.</b> Violence at Standing Hollow during the Moot is taboo and consequence-bearing. Outside the Moot, the holds and circles have other ways of disagreeing.</li>
<li>Good fits: druid apprentices, hold-reeves, bards, wandering folk, settlers with a complicated relationship to the wild.</li>
</ul>`),
    ],
    genre: "fantasy",
    tags: ["wilderness", "exploration", "frontier", "low-magic"],
    contentWarnings: ["violence"],
    pacing: "casual",
  },

  {
    slug: "dawnvault",
    name: "Dawnvault",
    description: "A city built around a buried temple where the sun is said to sleep. Pilgrims come. Some leave changed.",
    pages: [
      bg(`<p>Dawnvault grew up around the <b>Sealed Temple</b>: a buried complex older than any standing wall on the continent, where the priesthood claim a sleeping aspect of the sun lies dreaming. Whether or not this is metaphor, the city makes good money on pilgrims who believe it is not.</p>
<p>The city is terraced down the side of a mountain whose peak is the Lantern Tier, the seat of the <b>Hierarch</b>, the priesthood's chosen ruler. The Temple Guard rules in fact. The Hierarchs change; the Guard endures. Pilgrims walk the upper rings of the Temple. Acolytes walk the middle. The lower rings are where Hierarchs go to die, voluntarily, in old age, by the rite that ends every Hierarchy. Novices are occasionally sent down. They do not always return.</p>
<p>The city's other industries, silver, pilgrimage-trinkets, scholarship, exist in the temple's shadow. Heresy is a quiet crime. Public unbelief is unwise. Private unbelief is more common than the priesthood admits.</p>`),
      npcs(`<ul>
<li><b>Hierarch Ostren the Twelfth</b>, current Hierarch, in his fifty-eighth year. Frail, sharp-minded, rumored to be approaching his Descent. Has refused to name a successor.</li>
<li><b>Captain-Vigilant Mara Sael</b>, head of the Temple Guard. Pragmatic, irreligious, openly loyal to the institution rather than its faith. Holds her office because nobody else can.</li>
<li><b>Acolyte-Scholar Yris</b>, young, exceptionally gifted, the kind of acolyte the priesthood loves until she opens her mouth. Has been heard arguing with three different Hierarchs and is still wearing the white.</li>
<li><b>Tovar the Pilgrim-Master</b>, runs the largest pilgrim hostel and the most lucrative trinket trade in the upper city. Knows everyone, owes a few, is owed by more.</li>
<li><b>The Voice of the Lower Rings</b>, a figure in lay garments who appears, occasionally, in the city's quieter taverns. Speaks softly about doctrines the priesthood has officially forgotten. The Guard would very much like to know who this is.</li>
</ul>`),
      places(`<ul>
<li><b>The Sealed Temple</b>, six known rings, descending. The Pilgrim Ring is open. The Acolyte Ring is restricted. The Inner Rings are sealed except to the priesthood; the Lower Rings are sealed to nearly everyone.</li>
<li><b>The Lantern Tier</b>, the Hierarch's seat. Highest point in the city. Visible for forty miles in clear weather.</li>
<li><b>The Pilgrim Ring</b> (city level), the bustling tourist quarter. Hostels, trinket shops, dye-houses producing the white pilgrim-robe. The economy that keeps the city standing.</li>
<li><b>The Long Stair</b>, the ceremonial route from the city's outer gate to the Pilgrim Ring of the Temple. Three thousand steps; pilgrims climb it on the dawn of the Long Day.</li>
<li><b>Outer Dawnvault</b>, slums and warrens at the mountain's foot. The Temple Guard's authority is light here. So is the priesthood's interest.</li>
</ul>`),
      lore(`<p><b>The Sleeping Sun.</b> The priesthood teaches that the sun has many aspects, and one of them, the Quiet Sun, sleeps beneath Dawnvault and will wake at the end of the world. Pilgrims pray to be touched by its dream. Heretics ask what happens if it wakes early.</p>
<p><b>The Descent.</b> Every Hierarch ends their reign by walking down into the Lower Rings, where no living person follows. The rite is older than the priesthood's official theology. Hierarchs prepare for it for years; most go willingly.</p>
<p><b>The Lost Doctrines.</b> The priesthood has officially "forgotten" certain teachings from the earliest era of the Hierarchy. The texts exist, somewhere; they are not for public eyes. The Voice of the Lower Rings appears to be teaching them anyway.</p>`),
      rules(`<p>Tone: theocratic fantasy with a dungeoncrawl underbelly. Pilgrimage, faith, doubt, the politics of priesthood.</p>
<ul>
<li><b>Faith is a force in the world.</b> Priestly miracles happen. Light, healing, warding, yes. The Quiet Sun's reality is the central ambiguity; play to the question, not the answer.</li>
<li><b>The Lower Rings are dangerous.</b> Going down there without invitation is a horror-adjacent dungeoncrawl, not a romp. Death is possible.</li>
<li><b>Heresy has consequences.</b> The Guard doesn't burn people for theological mistakes, but careers, marriages, and welcomes can end abruptly.</li>
<li><b>Pilgrims come from everywhere.</b> Characters can pass through Dawnvault from any other setting; the Long Day pilgrimage is one of the great cross-world reasons to be in town.</li>
<li>Good fits: pilgrims, acolytes, heretic scholars, Temple Guard, the merchants who feed them all.</li>
</ul>`),
    ],
    genre: "fantasy",
    tags: ["mystery", "urban", "high-magic"],
    contentWarnings: ["dark-themes"],
    pacing: "structured",
  },

  /* ============================================================
   *  Feudal Japan / Eastern Fantasy
   * ============================================================ */
  {
    slug: "tsukikage",
    name: "Tsukikage",
    description: "Feudal-era mountain provinces where yokai walk old roads and a samurai's sword is rarely the strangest thing on it.",
    pages: [
      bg(`<p>Tsukikage, the <b>Moonshadow Provinces</b>, are a series of mountain valleys where the old spirits never quite left. Villages sit in the folds; <b>samurai</b> families hold the passes; <b>yokai</b> walk the roads after dusk, sometimes harmless, sometimes not.</p>
<p>The Imperial Court sits far away, beyond two ranges of mountains. The local <b>daimyo</b> rule in practice, often with one eye on each other and one eye on what walks under the moon. Tribute travels south to the capital twice a year. The capital's commands travel north slowly, if at all.</p>
<p>The current peace is sixty years old. Before it, the Three Houses War scarred the central valley; you can still see the burn-line on Mount Tetsu, where the <b>Yamabushi</b> monks of the mountain ended the worst of it. The monks remain. They walk the old roads, maintain wards at the boundary stones, and keep the kind of peace that is not the daimyo's to keep.</p>`),
      npcs(`<ul>
<li><b>Daimyo Akiyoshi Hidetada</b>, lord of the central valley. Mid-fifties, weathered, fond of poetry that nobody can interpret. Has held his seat through two earthquakes and one assassination attempt.</li>
<li><b>The Abbess of Mount Tetsu</b>, head of the Yamabushi order. Refuses to be addressed by a personal name. Walks down to the valley once a year, at midwinter, to renew the boundary-stones with her own hand.</li>
<li><b>Hatsumi the Lantern-Bearer</b>, wandering samurai, masterless by choice. Travels with a paper lantern that does not blow out. Has reputed dealings with at least one yokai who owes her a favor.</li>
<li><b>The Fox of Three Names</b>, a kitsune who has lived near the shrine on the Moon Road for two centuries, possibly three. Trades favors for stories. Tells lies of the truthful sort.</li>
<li><b>Lord Kuroda Genshiro</b>, the western daimyo. Younger, ambitious, has been raising his garrison for reasons that don't quite track with the official inventories.</li>
</ul>`),
      places(`<ul>
<li><b>The Moon Road</b>, the main east-west route through the central valley. Lined with stone lanterns, several of them still lit by no obvious means. Most yokai sightings happen on or near this road.</li>
<li><b>Mount Tetsu</b>, sacred peak, seat of the Yamabushi order. Pilgrims allowed on the lower slopes; the temple proper is reachable only by invitation.</li>
<li><b>Hisame Village</b>, modest farming village at the central crossroads. Known for its rice and its <b>kitsune-shrine</b>, a small fox-shrine that has been continuously tended for four hundred years.</li>
<li><b>The Akiyoshi Keep</b>, Daimyo Akiyoshi's seat. A black-tile castle on a low hill. Audiences are granted on the fifteenth day of each month; petitions are taken any day.</li>
<li><b>The Lonely Crossroad</b>, a place at the eastern edge of the valley where three roads meet. People do not stop there at night. Nobody is sure why; the stories disagree.</li>
</ul>`),
      lore(`<p><b>Yokai.</b> The valley is full of them, mischievous, malevolent, lonely, ancient. Most are harmless to a traveler who knows the small courtesies: bow at certain trees, offer rice at certain stones, do not look behind you on the Lonely Crossroad. The Yamabushi maintain treaties with many of the major yokai; the daimyo, with several.</p>
<p><b>The Three Houses War.</b> Sixty years past. Two of the three houses are gone; the third (Akiyoshi) holds the central valley. The Yamabushi ended the war by an act they will not describe. The burn-line on Mount Tetsu is the visible scar.</p>
<p><b>The Lantern Pact.</b> The deal between the Yamabushi and the major yokai of the valley. Said to specify that mortals may pass under the lanterns of the Moon Road in safety, provided they neither stop, speak, nor steal between dusk and dawn. The Pact is observed. Mostly.</p>`),
      rules(`<p>Tone: feudal Japan with one foot in the spirit world. Honor, duty, doomed romance, the weight of family obligation.</p>
<ul>
<li><b>Magic is folklore, not engineering.</b> Yamabushi monks, shrine maidens, and a handful of yokai-touched mortals can do real spiritual work, exorcism, warding, divination. Nobody throws fireballs.</li>
<li><b>Yokai are people too.</b> Most are not antagonists. They are different. Hostility is a story choice, not a default.</li>
<li><b>Combat is meaningful and rarely casual.</b> A sword cut is a serious thing. Recovery takes weeks. Players are encouraged to favor de-escalation, oath, and ritual.</li>
<li><b>Honor matters.</b> Public shame, debt, oath-bond, and obligation drive plots. Characters can act dishonorably; they pay for it.</li>
<li>Good fits: ronin, retainers, shrine-keepers, traveling monks, foreigners who arrived through a misunderstanding.</li>
</ul>`),
    ],
    genre: "mythological",
    tags: ["mystery", "exploration", "wilderness"],
    contentWarnings: ["violence", "dark-themes"],
    pacing: "structured",
  },

  {
    slug: "the-jade-court",
    name: "The Jade Court",
    description: "A courtly capital of silken intrigue, ancestor halls, and dragons who occasionally remember they are dragons.",
    pages: [
      bg(`<p>The <b>Jade Court</b> is the seat of the Celestial Dynasty, a vast, ancient empire whose capital is a city of silk, lacquer, and a thousand small ceremonies. Every gesture means something. Every silence means more.</p>
<p>The <b>Empress</b> sits on the Jade Throne. She is officially in her two hundred and tenth year of life. Court astrologers do not contradict this, at least not in writing. She has outlived three husbands, six chancellors, and (according to whispers no scholar will commit to paper) one of the celestial dragons.</p>
<p>The empire is largely at peace. Its borders are watched but not contested. The steppes to the north send tribute, mostly. The southern provinces produce silk, jade, and the bureaucrats who run the empire's middle layers. Real conflict, when it happens, happens inside the palace walls.</p>`),
      npcs(`<ul>
<li><b>Empress Lai Wuyue, the Jade Mirror</b>, current sovereign. Slender, pale, never raises her voice. Has not left the inner palace in eighteen years. Commands by the smallest gesture; everyone watches her hands.</li>
<li><b>Chancellor Min Tao</b>, head of the Six Ministries. Pragmatic, exhausted, holds the empire together through sheer accumulated favor. Will retire when the Empress permits, not before.</li>
<li><b>Lady Hua of the Crane Pavilion</b>, the empire's most quoted poet. Officially a guest of the Court; unofficially the Empress's confidante. Her poems decide reputations.</li>
<li><b>General Bo Sheng of the Northern Wall</b>, career soldier, gruff, beloved of his troops, distrusted by court. Holds the steppe border with thirty thousand soldiers and an ever-shrinking budget.</li>
<li><b>The Old One of the Eastern Peaks</b>, a celestial dragon. Has not been seen in seventy years. Court protocol still reserves a seat at certain ceremonies. The seat is never used.</li>
</ul>`),
      places(`<ul>
<li><b>The Palace of the Jade Throne</b>, the inner palace. Concentric courtyards, gardens, ancestor halls. Only the Empress moves freely through all of them. Most courtiers see two or three.</li>
<li><b>The Hall of a Thousand Names</b>, the ancestor hall. Names of every emperor and every chancellor going back fourteen hundred years. Ritual offerings are made daily.</li>
<li><b>The Six Ministries' Quarter</b>, the working capital. Eighteen thousand bureaucrats. The actual business of empire happens here, in offices that smell of ink and tea.</li>
<li><b>The Outer City</b>, markets, embassies, the noisy commercial layer that the inner palace pretends not to notice. Foreign emissaries are housed here, in the Embassy Lanes.</li>
<li><b>The Eastern Peaks</b>, sacred mountains, dragon-domain, edge of empire. Pilgrimage country. The Old One is said to sleep on the highest peak.</li>
</ul>`),
      lore(`<p><b>The Celestial Mandate.</b> The Dynasty's claim to rule rests on a compact with the celestial dragons, sworn nine hundred years ago. The compact's exact terms are state secrets; the Empress is said to know them in full.</p>
<p><b>The Six Ministries.</b> Rites. Revenue. War. Justice. Works. Personnel. Each is a small kingdom of its own, with its own grudges, its own promotions, its own cells of secret loyalty. Most political plots in the Court are inter-ministerial.</p>
<p><b>The Exam System.</b> The empire's bureaucrats are selected by examination, theoretically by merit, practically by an opaque mix of merit, family, and timing. The Imperial Examinations are held every third year. The results are watched as carefully as a war.</p>`),
      rules(`<p>Tone: high-courtly fantasy. Silken intrigue, ancestor reverence, the slow drift of power across a long generation.</p>
<ul>
<li><b>Protocol matters.</b> The wrong bow can end a career. Characters should know, or visibly fail to know, the rituals of address.</li>
<li><b>Dragons are real and ancient.</b> They are not creatures to fight. They are powers to negotiate with, when one appears at all. They appear rarely.</li>
<li><b>Magic is ritual.</b> Court astrologers, ancestor-callers, geomancers. The work is slow, expensive, and consequential. No spell-slinging.</li>
<li><b>Politics is the engine.</b> The Empress's silences, ministerial promotions, ambassador arrivals, these drive stories more than the sword.</li>
<li>Good fits: courtiers, scholars, ministers, ambassadors, exam candidates, poets, the occasional border-soldier home on leave.</li>
</ul>`),
    ],
    genre: "fantasy",
    tags: ["courtly", "intrigue", "political"],
    contentWarnings: ["violence"],
    pacing: "structured",
  },

  {
    slug: "ashigara-coast",
    name: "Ashigara Coast",
    description: "Storm-battered fishing villages, sword-saints in self-imposed exile, and pirate fleets who claim ancestral grudges.",
    pages: [
      bg(`<p>The <b>Ashigara Coast</b> is a string of fishing villages and small ports along a stretch of sea-cliff country. The land is poor. The fishing is excellent. The pirates of the <b>Storm Isles</b>, three large islands and a hundred small, are, depending on the season, either visitors or invaders.</p>
<p>The villages survive by tribute, treaty, and luck. Each pays the Sea-Captains of the Isles a yearly sum to be left alone; the Sea-Captains, mostly, honor the deal. Mostly. The villages also pay the central daimyo's tax-collectors a separate yearly sum to pretend the first sum doesn't exist. This balance has held for a century. It is now wobbling.</p>
<p>The reason it is wobbling: the Sea-Captains have a new heir. The old captain died last year. The new one is making different kinds of decisions. Nobody quite knows yet what she wants.</p>`),
      npcs(`<ul>
<li><b>Sea-Captain Misuzu Take</b>, the new heir, twenty-six years old, the first woman to hold the title in eighty years. Cold, capable, has not yet announced her terms for this year's tribute.</li>
<li><b>Headman Toshiro of Senpu Village</b>, wiry old man, has been headman for thirty-one years. Personally negotiated the last three tribute treaties. Looks tired.</li>
<li><b>Daiki the Lighthouse Saint</b>, wandering sword-saint, settled at the Senpu lighthouse two years ago. Lives in the keeper's cottage. Speaks rarely. The lighthouse has stopped attracting wreckers.</li>
<li><b>Daimyo's Tax-Agent Hosokawa Ren</b>, the official the central daimyo sends every spring. Knows about the pirate tribute. Pretends not to. His tea is excellent.</li>
<li><b>Captain Iname of the Lacquered Sail</b>, Sea-Captain Misuzu's lieutenant, old guard, served her father. Disagrees with the new direction. Hasn't said so out loud yet.</li>
</ul>`),
      places(`<ul>
<li><b>Senpu Village</b>, the largest of the coast villages, eight hundred souls. Has the lighthouse, the deepest harbor, the headman's hall, and the village shrine. All tribute negotiations happen here.</li>
<li><b>The Senpu Lighthouse</b>, built two centuries ago, kept burning continuously since. Currently houses one keeper, one keeper's apprentice, and Daiki.</li>
<li><b>The Storm Isles</b>, pirate-held archipelago, a day's hard sail from the coast. The capital, if it can be called that, sits on the largest island and is called <b>Three-Tides</b>. Outsiders are rarely invited; the few who come back tell strange stories.</li>
<li><b>The Sunken Shrine</b>, a small shrine on a tidal rock between the coast and the Isles. Visible only at low tide. The shrine is older than either civilization. Both groups leave offerings.</li>
<li><b>Backwater Inlet</b>, smuggler-haunt north of Senpu. Nobody officially knows about it. Everybody officially knows about it.</li>
</ul>`),
      lore(`<p><b>The Old Defeat.</b> The Sea-Captains claim descent from a defeated noble house, exiled to the Isles after a war four centuries past. They have never accepted that the war ended. The tribute they collect is, in their telling, the lawful tax of their rightful coastline.</p>
<p><b>The Sunken Shrine's Pact.</b> An older agreement, predating the noble house's defeat: that the coast and the Isles will not destroy one another. Said to be guaranteed by whatever sleeps under the shrine. The few times a side has tried, weather has been spectacularly against them.</p>
<p><b>The Sword-Saints.</b> Wandering masters, usually masterless, who have stepped beyond the ordinary samurai's relationship with the blade. They are not common. There are perhaps a dozen alive at any time. Daiki is one. Why he settled here is his business.</p>`),
      rules(`<p>Tone: storm-coast samurai with a strong sea-adventure pulse. Tribute, exile, masterless masters, weather as a character.</p>
<ul>
<li><b>Combat is decisive.</b> A sword-saint will end most fights in a stroke. Players should treat blades as serious, fatal tools.</li>
<li><b>The sea is sacred and dangerous.</b> Storms come fast. The Sunken Shrine's protection is real but not unconditional.</li>
<li><b>Pirates are people.</b> The Sea-Captains' folk are not faceless raiders; they have their own honor code, their own grievances, their own families on the Isles.</li>
<li><b>The tribute system is the stakes.</b> Most stories live in the tension between coast, Isles, and central daimyo. Disrupting the balance has consequences for everyone.</li>
<li>Good fits: village folk, ronin, lighthouse-keepers, pirate-raiders, sword-saints in retreat, tax-agents pretending not to notice.</li>
</ul>`),
    ],
    genre: "fantasy",
    tags: ["frontier", "war", "combat-heavy"],
    contentWarnings: ["violence"],
    pacing: "casual",
  },

  /* ============================================================
   *  Science Fiction
   * ============================================================ */
  {
    slug: "neon-meridian",
    name: "Neon Meridian",
    description: "A vertical megacity where corp arcologies tower over rain-slick alleys and your augments are leased, never owned.",
    pages: [
      bg(`<p><b>Meridian</b> is a single vertical city, twelve kilometers tall, ringing the equator. The upper decks belong to the <b>Big Six</b> corps and the people who can afford their air. The middle decks are where most people live and most trouble happens. The lower decks are the dark and the wet, where the city eats itself slowly.</p>
<p>The official population is forty-two million. The actual population is unknown, the lower decks haven't been censused in twenty years and the upper decks lie about their counts for tax reasons. The <b>Council of Six</b> doesn't govern. It negotiates. The Free City Charter from sixty years ago says Meridian is a sovereign trade entity; in practice it's six interlocking corporate fiefs that occasionally agree to call themselves a city.</p>
<p>Augments are everywhere. Most are leased. Your eyes, your reflexes, your liver, your new lungs, if you can't keep up the subscription, the corp turns them off, and the lower decks are full of people who couldn't keep up the subscription.</p>`),
      npcs(`<ul>
<li><b>Director Aki Nakajima-Vance</b>, head of Nakajima-Vance Energy, the youngest of the Big Six directors. Public face is patient and reassuring; the people who work with her find her exact.</li>
<li><b>The Doctor</b>, back-alley implant surgeon working out of a basement clinic on Deck 47. No corp licensing, no questions, cash only. The middle decks' open secret.</li>
<li><b>Sera Iwata</b>, fixer. Connects runners with jobs and jobs with runners. Operates out of a noodle bar called Twelve Knives. Knows everyone, owes nobody.</li>
<li><b>Marshal Bren Caldas</b>, Council-appointed peacekeeper for the middle decks. Honest. Underfunded. Has not been on the upper decks in eight years.</li>
<li><b>The Walker</b>, figure in the lower decks who walks the same route every night, never speaks, and has been seen by every long-term lower-deck resident at some point. Theories about who or what the Walker is fill several conspiracy boards.</li>
</ul>`),
      places(`<ul>
<li><b>The Upper Decks (3 km–12 km)</b>, corp territory. Arcologies, private security, sealed air. Citizenship is by employment. Walking the street without an authorized badge is a crime.</li>
<li><b>The Middle Decks (500 m–3 km)</b>, where the city actually lives. Markets, apartments, schools, the famous neon-lit canyon called the <b>Long Avenue</b>. The Marshal's beat.</li>
<li><b>The Lower Decks (ground–500 m)</b>, dark, wet, half-abandoned. Some manufacturing, some warrens, a real ecology of unhooked people and forgotten machines. The corps officially don't go down there. Their salvage teams do, regularly.</li>
<li><b>Twelve Knives</b>, noodle bar on Deck 22. Sera Iwata's office, by long convention. Best noodles in the middle decks; the soup is real, the rest is plant-derived.</li>
<li><b>The Audit Floor</b>, a deck nobody is sure exists. Rumored to be where the Council's enforcement arm operates. Every few years someone disappears who was clearly going to be audited. The Council does not comment.</li>
</ul>`),
      lore(`<p><b>The Big Six.</b> Daimyo-Tessen Heavy. Aurelius Genomics. Triskelion Logistics. Hokkai Networks. Nakajima-Vance Energy. The Black Dahlia Group. Each has its own enclave, its own private security, its own understanding of what "law" means inside its walls. Inter-corp wars are fought through proxies, lawsuits, and the occasional precise assassination.</p>
<p><b>The Audit.</b> Every few years the Council announces an Audit. Nobody outside the Audit knows what it audits, who it targets, or what its findings do. People disappear during Audits. Sometimes corps lose departments. Once, a director.</p>
<p><b>The Free City Charter.</b> The legal fiction that Meridian is a sovereign trade entity rather than six corporate fiefs in a stack. Renegotiated every twenty years. The next renegotiation is in four. Both sides are already positioning.</p>`),
      rules(`<p>Tone: classic cyberpunk. Body modification, corporate vassalage, identity-as-a-service, neon and rain.</p>
<ul>
<li><b>Augments are mundane.</b> Most characters have at least one. Treat them like prosthetics or smartphones, not like superpowers.</li>
<li><b>Magic does not exist.</b> Hard sci-fi posture; the strange things in the lower decks have material explanations even when nobody knows them.</li>
<li><b>The corps win most fights.</b> Stories tend to be heists, escapes, sabotage, identity work. Pitched battles end badly for non-corp players.</li>
<li><b>Lethal but not nihilistic.</b> Death is real; the city is not pointless. Characters can build a life in the cracks.</li>
<li>Good fits: runners, fixers, ex-corporate, ex-military, journalists, medics, the occasional honest cop.</li>
</ul>`),
    ],
    genre: "scifi",
    tags: ["urban", "intrigue", "combat-heavy"],
    contentWarnings: ["violence", "substance"],
    pacing: "structured",
  },

  {
    slug: "the-belt",
    name: "The Belt",
    description: "Asteroid stations strung between Mars and Jupiter. Atmosphere is rented, rotation is rationed, and inner-system favors come due.",
    pages: [
      bg(`<p>The <b>Belt</b> is the asteroid economy, thousands of stations, mining claims, and tucked-away habitats spread between Mars and Jupiter. The inner planets call it the frontier. The Belt calls itself a civilization the inner planets are too provincial to recognize.</p>
<p>The <b>Coalition of Free Stations</b> is real but loose: a treaty body that ratifies the rules of dock, water, and air shared across the Belt, and tries to speak with one voice when the inner-system navies show up. Most stations have their own local government. Most also have at least one Coalition presence, a hangar, a customs office, an arbiter.</p>
<p>Life in the Belt is small-margin. Atmosphere is rented; rotation is rationed; water flows through a hundred reuse cycles before anyone admits it might be time to top up. Belt-born grow tall and lean. Inner-system visitors are obvious, and often condescending, within a day.</p>`),
      npcs(`<ul>
<li><b>Arbiter Mei Volk</b>, Coalition arbiter for the trailing-Jovian gate sector. Mid-fifties, soft-spoken, decides disputes the inner-system navies can't reach. Her word is final by treaty.</li>
<li><b>Captain Lex Holmgren</b>, runs the prospector tug <i>Wide Margin</i>. Twenty-year veteran, two divorces, three close calls. Knows every shortcut and which ones are worth taking.</li>
<li><b>Vire Eshe</b>, head dispatcher at Pallas High Dock. The most-bribed person in the trailing-Mars sector; somehow still has her job.</li>
<li><b>Commodore Reinhardt Veck (Earth Navy)</b>, current Earth Navy presence in the Belt. Polite, condescending, has not yet realized that the people he's policing are the people he depends on for water.</li>
<li><b>The Free Voice</b>, pirate broadcaster operating somewhere in the outer claims. Independence-line, occasionally insightful, never quite traceable. The Coalition has not, officially, tried to find them.</li>
</ul>`),
      places(`<ul>
<li><b>Pallas High Dock</b>, largest Coalition station in the trailing-Mars sector. Forty thousand permanent residents, twice that in transient population. The bars on Concourse 4 are legendary.</li>
<li><b>The Trailing-Jovian Gate</b>, gravitational sweet spot where most inner-system traffic queues for the long burn to the outer Belt. Always crowded. Always tense.</li>
<li><b>Vesta Hollow</b>, old mining station hollowed out into a habitat. Half a million people in a turning rock. The cultural capital of the Belt.</li>
<li><b>The Lost Claims</b>, half-mythical region of the outer Belt where prospectors who didn't pay their Coalition dues went to die. Or, occasionally, to thrive. The Free Voice broadcasts from somewhere in here.</li>
<li><b>Earth Navy Forward Base "Heliocenter"</b>, recently constructed, parked at a Lagrange point inside the Belt. The Coalition is officially fine with it. Unofficially, very not.</li>
</ul>`),
      lore(`<p><b>The Coalition Treaty.</b> Forty-two years old. Establishes shared standards for air, water, dock, rotation, and arbitration. Does not establish a Coalition government, that's a deliberate compromise. The treaty is renegotiated every twenty years; the next round is in eight.</p>
<p><b>The Three Currencies.</b> Air, water, and rotation. Everything else flows through them. A station that can guarantee all three is rich. A station that has run out of one is on its way to ceasing to exist.</p>
<p><b>The Long Burn.</b> Belt travel is slow. Trips of months are normal. Crews are family by necessity. The phrase "I burned with them" is the highest endorsement one Belter gives another.</p>`),
      rules(`<p>Tone: hard sci-fi, working-class space. Politics, labor, water rights, the lethal indifference of vacuum.</p>
<ul>
<li><b>Physics is real.</b> No FTL, no magic, no artificial gravity except by spin. Ships take time to get places.</li>
<li><b>The vacuum kills.</b> Decompression, oxygen failures, micro-collisions, these are constant background risks. Players should respect the void.</li>
<li><b>Politics drives stories.</b> Inner-system overreach, Coalition disputes, station-versus-station rivalry. Pure combat plots are rarer than negotiated ones.</li>
<li><b>Belter culture is real.</b> Different cadence, different priorities, different gestures. Inner-system characters are visibly out of place.</li>
<li>Good fits: prospectors, station crew, arbiters, traders, Coalition functionaries, inner-system imports who are learning fast.</li>
</ul>`),
    ],
    genre: "scifi",
    tags: ["exploration", "frontier", "political"],
    contentWarnings: ["violence"],
    pacing: "structured",
  },

  {
    slug: "salvage-empire",
    name: "Salvage Empire",
    description: "Generations after a war that ended civilization, fleets pick over the bones of the old high orbit and call it home.",
    pages: [
      bg(`<p>The war ended four generations ago. Nobody now living was there. What remains is a broken ring of debris around the planet, hundreds of thousands of derelicts, dead stations, frozen corpses, and the occasional still-running ship that nobody in living memory has dared board.</p>
<p>The <b>Salvage Houses</b> pick this ring clean for a living. They are also, slowly, building a strange new civilization in orbit out of the wreckage. Their cities are bolted-together: old habitat modules, command sections, hangar bays, half-burned dreadnought hulks turned into apartment blocks. The Houses have their own laws, their own grievances, their own carefully maintained myths about who started the war and who finished it.</p>
<p>Down on the planet, scattered communities remain, some thriving, some isolated, all dependent on what the Houses choose to send down. The Houses, in turn, depend on the planet for water, biomass, and the occasional new recruit.</p>`),
      npcs(`<ul>
<li><b>House Iron's Director, Olette Vance</b>, calculating, long-tenured, the closest thing the Houses have to a senior statesman. Has held her seat for thirty-one years.</li>
<li><b>Captain Mae Trell of House Bell</b>, scout-fleet captain. Lost three crew to something that wasn't decompression last month. Has been quiet about it.</li>
<li><b>The Voice of House Below</b>, speaks for the youngest House. Identity not publicly known; the role rotates. Currently bolder than the previous Voice was.</li>
<li><b>Surgeon-Engineer Vix</b>, works the boundary between ship-surgery and live-augmentation. Operates from a converted medical frigate the other Houses pretend not to know about.</li>
<li><b>The Listener</b>, runs the long-range receivers on House Mercer's flagship. The only person currently transcribing the new broadcasts. Has been sleeping badly.</li>
</ul>`),
      places(`<ul>
<li><b>The Ring</b>, debris field in high orbit. Hundreds of thousands of derelicts. Major shipping lanes are mapped and policed by the Houses; the deep Ring is unmapped, dangerous, occupied by wrecks that are sometimes more than wrecks.</li>
<li><b>Anchor Town</b>, House Iron's main habitat. Bolted-together hulks, two hundred thousand residents. The largest standing settlement of any kind that humans have anymore.</li>
<li><b>The Below</b>, House Below's territory in the deepest Ring. Other Houses don't go in. House Below's people don't always come out.</li>
<li><b>Downside</b>, the largest planet-side settlement. Forty thousand souls. Trade hub for the surface communities; House liaison offices line the central avenue.</li>
<li><b>The Quiet</b>, region of the Ring where every sensor reads silent. Several scout missions have gone in. None have reported back. Officially, scouts are forbidden.</li>
</ul>`),
      lore(`<p><b>The War.</b> What ended civilization. No surviving record agrees on who fought whom or why. The Houses each carry a different official history; none of the histories are entirely true. A few of the Voices probably know more than they say.</p>
<p><b>The Still-Running Ships.</b> A small number of derelicts in the deep Ring are inexplicably still under power. They have refused boarding for four generations. Recently, one has begun broadcasting again. The language is not in any House's archives.</p>
<p><b>The Houses' Code.</b> Five Salvage Houses (Iron, Bell, Mercer, Whitehand, Below) have a working compact that governs salvage rights, territory, and the rare inter-House marriage. The compact has been amended four times. Each amendment was preceded by violence.</p>`),
      rules(`<p>Tone: post-apocalypse space salvage. Faded majesty, mended civilization, the open question of why the war happened.</p>
<ul>
<li><b>Technology is found, not built.</b> Most working gear comes off old hulks. Repair is a high skill; manufacturing is mostly limited to ammunition and food.</li>
<li><b>Salvage is dangerous.</b> Vacuum, decompression, traps, the occasional still-running automated defense. Boarding parties don't always come back.</li>
<li><b>The mystery of the war is the spine.</b> Don't expect the answer in act one. Stories work by accumulating fragments.</li>
<li><b>The Houses are people.</b> Players usually owe allegiance to at least one. Switching Houses is possible but costly.</li>
<li>Good fits: salvage-crew, scouts, surgeon-engineers, House diplomats, planet-side liaisons, the occasional defector from House Below.</li>
</ul>`),
    ],
    genre: "scifi",
    tags: ["frontier", "exploration", "war"],
    contentWarnings: ["violence", "dark-themes"],
    pacing: "structured",
  },

  {
    slug: "the-hollow-ark",
    name: "The Hollow Ark",
    description: "A generation ship two centuries off course. The crew remembers Earth as a story. Something else is awake in the lower decks.",
    pages: [
      bg(`<p>The <b>Ark</b> left Earth two hundred and sixty years ago, bound for a system its mission planners promised would be habitable. Nobody on board has ever seen Earth. Nobody on board is sure where they are. The course logs were corrupted in the third generation; the archive was sealed by the fourth. The current generation calls Earth "the Story." The young don't always believe in it.</p>
<p>The ship is twelve decks officially. Thirteen unofficially, the lower deck has been sealed for sixty years, since the Quiet Mutiny, and the seal has begun, recently, to flex. The current <b>Captain</b> is the eleventh to bear the title. She has been Captain for nine years and is increasingly uncertain whether the ship is still under way.</p>
<p>Population sits steady at around six thousand. Births are regulated. Deaths are routine. Most people will never go more than two decks from where they were born.</p>`),
      npcs(`<ul>
<li><b>Captain Inara Bell</b>, eleventh Captain, fifty-one years old, three years into her second term. Inherited a ship she doesn't fully trust from a predecessor who refused to brief her on certain matters.</li>
<li><b>Chief Engineer Roe</b>, sixties, gray, has personally serviced every reactor on the ship. Knows which decks aren't where the schematics say they are. Refuses to discuss the lower deck.</li>
<li><b>Archivist Sela</b>, keeper of the sealed archive. One of the three people with theoretical access. Has not opened it in her tenure. Has been reading the Captain's old reports instead.</li>
<li><b>Dr. Olen Vest</b>, chief medical officer. Has noticed an anomalous health pattern on Decks 9–11. Has not yet told the Captain.</li>
<li><b>The Voice in the Wall</b>, children on Deck 10 have, for two years, reported a friendly voice that whispers stories at night. Adults dismissed it. Recently, an adult has heard it.</li>
</ul>`),
      places(`<ul>
<li><b>The Bridge (Deck 1)</b>, command. Skeleton crew on rotation. Most of the original console functions don't work; nobody quite remembers how to repair them.</li>
<li><b>The Habitat Decks (2–8)</b>, where most of the ship lives. Apartments, gardens, schools, the Long Promenade where the Captain holds her quarterly speech.</li>
<li><b>The Working Decks (9–11)</b>, engineering, hydroponics, machine shops. Where most of the crew labors. Dr. Vest's anomalous pattern shows up here.</li>
<li><b>The Sealed Deck (12)</b>, locked since the Quiet Mutiny. Officially evacuated and shut down. Unofficially, sometimes things tap from the other side.</li>
<li><b>The Archive Vault</b>, between Decks 6 and 7. Contains course logs, founder records, and (allegedly) the original mission instructions. Three keys exist; all three holders refuse to use them.</li>
</ul>`),
      lore(`<p><b>The Story of Earth.</b> What the crew remembers of where they came from: blue planet, vast oceans, a civilization that decided to send seeds elsewhere. The Story has drifted across generations. Significant details disagree.</p>
<p><b>The Quiet Mutiny.</b> Sixty years ago. The lower deck was sealed in the aftermath. Records were redacted. The Captain at the time was the eighth; she resigned afterward and lived another eleven years without speaking of it. The current Captain has read everything she left. It is not enough.</p>
<p><b>The Drift.</b> Are they still on course? Nobody is sure. The astronomical instruments are old and have not been re-calibrated against a known reference in four generations. The Chief Engineer thinks the answer is yes. The Captain thinks the answer is mostly. The Archivist suspects the answer is no.</p>`),
      rules(`<p>Tone: slow, quiet, claustrophobic sci-fi. Generation-ship melancholy. Mystery and creeping dread.</p>
<ul>
<li><b>Everyone is from here.</b> No characters from outside the Ark. Every character's family has been on board for generations.</li>
<li><b>Tech is finite.</b> The Ark is the only technology. Spare parts are real wealth. Engineers are aristocracy.</li>
<li><b>The mystery unfolds slowly.</b> What happened in the Quiet Mutiny, what's in the lower deck, what the Voice is, these are not first-session reveals.</li>
<li><b>Population is small.</b> Six thousand people; everyone knows someone. Reputation, gossip, family obligation drive much of the social fabric.</li>
<li>Good fits: crew, engineers, medics, archivists, deck-workers, the occasional dissident asking questions everyone has agreed not to ask.</li>
</ul>`),
    ],
    genre: "scifi",
    tags: ["mystery", "investigation"],
    contentWarnings: ["dark-themes", "body-horror", "death"],
    pacing: "structured",
  },

  {
    slug: "ortus-prime",
    name: "Ortus Prime",
    description: "A first-contact colony where humans and the native Ortusi share a rebuilt city, politely, tensely, with daily small disasters.",
    pages: [
      bg(`<p><b>Ortus Prime</b> is the first joint city. The <b>Ortusi</b> were already here when humans arrived sixty years ago; they had not, until then, encountered another sapient species, and the experience has been, by all accounts, complicated.</p>
<p>The original colony landing was a small ecological accident. The Ortusi response was a larger diplomatic one. After a tense decade, the species agreed to build a city together, in the river-valley where the lander had come down. Ortus Prime now houses about eighty thousand people, roughly equal numbers of each species, plus a small population of children born to mixed-species households who are quietly redefining what "either species" means.</p>
<p>The <b>Joint Council</b> governs: eleven Ortusi, eleven humans, plus a rotating arbiter. They argue about everything. They have built, against the odds, a city where both species can mostly live without killing each other.</p>`),
      npcs(`<ul>
<li><b>Speaker-Elder Yera-Yoll</b>, senior Ortusi on the Joint Council. Mid-seventies in Ortusi years (which translate badly to human time). Patient, dry, considered slightly progressive among her people.</li>
<li><b>Governor Hala Marston</b>, senior human on the Joint Council. Career colonial administrator, second posting, more pragmatic than her predecessor. Currently overseeing a contentious factory expansion.</li>
<li><b>Translator-Adept Vell-Sain</b>, third-generation human; effectively native. Speaks the Ortusi tonal language with the rare full-vowel accuracy human throats can occasionally manage. Hated by both species' purists.</li>
<li><b>Ranger-Captain Mosi</b>, head of the joint mountain patrol. Half her crew is Ortusi, half human, and she will fight anyone who suggests the mix is the problem.</li>
<li><b>The Quiet Singer</b>, Ortusi cultural figure who has refused contact with humans for forty years. Lives in the upper mountains. Her presence is the moral test for the Ortusi older generation.</li>
</ul>`),
      places(`<ul>
<li><b>The Joint Quarter</b>, central city, where both species live mingled. Markets, schools (separated by morning/afternoon shifts to accommodate language), Council chambers. The original landing site is a small park here.</li>
<li><b>The Human Quarter</b>, the eastern third. Human-architecture, human-air-mix preferred, human shops. Currently expanding faster than the Joint Council has approved.</li>
<li><b>The Ortusi Quarter</b>, the western third. Built into the river-bluffs the way Ortusi cities have always been built. Cooler, dimmer, organized around the singing-courts.</li>
<li><b>The Upper Mountains</b>, old Ortusi land, mostly unsettled. Pilgrimage routes, sacred sites, the Quiet Singer's retreat. Joint patrols cover the lower passes; the higher slopes are Ortusi-only by treaty.</li>
<li><b>The Second Human Ship's Site</b>, fifty kilometers from the city. A second human colony ship arrived eight years ago, unannounced. The arrival was contested. The site is now a fortified outpost the Council has not officially recognized.</li>
</ul>`),
      lore(`<p><b>The Ortusi.</b> Tall (most are two meters or more), soft-spoken, deeply communal. Their language uses tonal modulation in ways human translators still botch. They find human individualism baffling, human food alarming, and the human practice of leaving children alone in rooms cruel. They make excellent diplomats and (humans like to think) terrible warriors. The latter is probably wrong.</p>
<p><b>The Joint Charter.</b> The founding document of Ortus Prime. Specifies shared governance, shared territory, joint patrols, mixed schools, and a slow phased integration of species into civic life. Re-ratified every fifteen years. The next ratification is in three. Both species have factions opposed.</p>
<p><b>The Second Ship.</b> Eight years ago, a second human colony ship arrived. It did not coordinate with the Joint Council. It established a colony fifty kilometers away. The Council has not formally recognized it. The Ortusi older generation considers this a treaty violation. The younger generation is more divided.</p>`),
      rules(`<p>Tone: first-contact drama. Patient, granular, civic. The slow work of two species learning to live together.</p>
<ul>
<li><b>Both species are real.</b> Players can play either, or mixed-species children. Neither species is a monolith; both have factions, dissenters, purists, reformers.</li>
<li><b>Cultural mistakes happen.</b> They have weight. Real apologies, real consequences. Not played for comedy.</li>
<li><b>Magic does not exist.</b> Hard sci-fi posture. Biology is biology. The Ortusi sing because their physiology rewards it, not because of mysticism.</li>
<li><b>The Council is the engine.</b> Most large stories pass through Council politics one way or another.</li>
<li>Good fits: Council functionaries, Joint Rangers, translators, scientists, mixed-species families, second-ship dissenters.</li>
</ul>`),
    ],
    genre: "scifi",
    tags: ["political", "slice-of-life"],
    contentWarnings: ["discrimination"],
    pacing: "casual",
  },

  /* ============================================================
   *  Modern / Modern Fantasy
   * ============================================================ */
  {
    slug: "ashford-bay",
    name: "Ashford Bay",
    description: "A small Pacific Northwest town where everyone knows everyone and the old families know more than they let on.",
    pages: [
      bg(`<p><b>Ashford Bay</b> is small, twelve thousand people, an old marina, three churches, one tavern that's seen four generations of the same family run it. Tourists come for the lighthouse and the season's salmon. Locals come for everything else.</p>
<p>It looks ordinary. It is, mostly, ordinary. The exceptions are the kind nobody talks about over breakfast at the diner, at least not while the wrong person might be listening. There are wrong people in Ashford Bay; the trick is knowing who they are.</p>
<p>The economy: fishing, mostly, but it's not what it was. A logging concern up the road. Two B&Bs catering to tourists. The Holcomb family's shipping company, which has been profitable for longer than the company has had a name. Most things in town pass through one of those, or through the marina, where the old families' interests intersect in ways that aren't always visible.</p>`),
      npcs(`<ul>
<li><b>Mayor Sara Holcomb</b>, third-generation Holcomb, second-term mayor, runs the family shipping office out of her front room. Friendly to a fault. Forgets nothing.</li>
<li><b>Sheriff Owen Marlett</b>, fourth-generation Marlett. Honest cop. Has been gently asked, four times in twelve years, not to ask certain questions, and has so far complied.</li>
<li><b>Etta Wren</b>, runs the diner. Knows what everyone in town has eaten for breakfast, and what everyone is pretending not to know about each other. Doesn't write any of it down.</li>
<li><b>Lighthouse-keeper Caleb Blackthorn</b>, youngest of the Blackthorn family. Recently resigned the keeper post for reasons he hasn't shared. Living in the Blackthorn cottage near the marina; rarely seen by daylight.</li>
<li><b>The Visitor</b>, every few years a stranger arrives, stays a week, asks specific questions of specific old-family members, and leaves. Nobody has yet established whether it's the same person each time.</li>
</ul>`),
      places(`<ul>
<li><b>The Marina</b>, the town's working heart. Holcomb Shipping, the fishing co-op, the boatyard. The Council holds informal meetings here as often as in the town hall.</li>
<li><b>The Lighthouse</b>, old, automated since the 1970s, but the keeper's post was never officially abolished. The cottage is still maintained. Caleb has the key.</li>
<li><b>The Diner</b>, Etta Wren's. Open six to two, six days a week. Where everyone in town overhears everything in town.</li>
<li><b>The Old Cemetery</b>, east edge of town. Marletts, Wrens, Holcombs, Blackthorns. Older sections have stones the Methodist church doesn't recognize.</li>
<li><b>The Lower Coast Road</b>, the road that doesn't go anywhere. Disused since the 1950s. Officially closed; the old families' kids know how to walk it.</li>
</ul>`),
      lore(`<p><b>The Old Families.</b> Holcombs, Wrens, Marletts, Blackthorns. Founded the town in 1834. They've been here continuously, mostly intermarried, and they know things about Ashford Bay that don't appear in any official record. There are agreements, courtesies, lines that aren't crossed.</p>
<p><b>The Marina Compact.</b> Unwritten. Probably oral. The old families pool decisions about who gets a boat slip, whose business gets a permit, who's invited to the Founders' Dinner. The mayor signs the official paperwork. The Compact decides who the mayor will be.</p>
<p><b>The Lighthouse.</b> Originally built in 1842. The Blackthorn family has kept the keeper's post in the family ever since. The light has gone out three times in two centuries. The mornings after were each, in their own way, memorable. The current Blackthorn resigned after the most recent failure.</p>`),
      rules(`<p>Tone: slow-burn modern with quiet supernatural. Small-town politics, secrets, old family ties.</p>
<ul>
<li><b>The supernatural is rare and unwelcome.</b> When it appears it's something specific, a missing person, a body in the wrong condition, an old story turning out true. Not a casual element.</li>
<li><b>Most of life is mundane.</b> Diner shifts, Council meetings, the school play, the boat that broke down last weekend. Stories grow from this fabric, not against it.</li>
<li><b>The old families are not villains.</b> They're protective, controlling, sometimes complicit, but they kept this place going. Players can fight them, court them, marry into them. They are not enemies by default.</li>
<li><b>Newcomers are visible.</b> Anyone not born here gets the polite-distance treatment for a year minimum. The locals notice.</li>
<li>Good fits: slice-of-life with edges, supernatural mystery, returning natives, newcomers with reasons, the kind of journalist who poked the wrong thing in a previous city.</li>
</ul>`),
    ],
    genre: "modern",
    tags: ["mystery", "slice-of-life", "investigation"],
    contentWarnings: ["dark-themes"],
    pacing: "casual",
  },

  {
    slug: "veiled-city",
    name: "The Veiled City",
    description: "Modern New York with the Veil drawn back: alchemists in Brooklyn, a vampire court in Midtown, and a tense detente nobody discusses.",
    pages: [
      bg(`<p>The <b>Veiled City</b> is the present day, the city you know, and a layer beneath it that runs in parallel, shielded from mortal sight by the <b>Veil</b>. Alchemists, witches, vampires, fae enclaves, ghoul-haunts, ancient orders. All going about their business in the same coffee shops as everyone else.</p>
<p>The Veil isn't magic in the storybook sense. It's an agreement, a layered, ancient, often-violated treaty that keeps the supernatural community out of mortal sight while individual supernatural beings live their daily lives in plain view. A vampire orders coffee. The barista doesn't quite see the canines. The Veil holds.</p>
<p>The <b>Concordat</b> keeps the peace between factions. It is hosted by no one, signed by everyone, and enforced by the few who have the standing to enforce anything at all. The last major Concordat violation was in 1978; the response was severe enough that everyone has been polite ever since.</p>`),
      npcs(`<ul>
<li><b>The Pale Countess</b>, head of the Crimson Court. Five hundred years old, soft-spoken, holds court in a Midtown penthouse. The Court's diplomatic face; the dangerous part of the Court works through her in ways she officially doesn't know about.</li>
<li><b>Sister-Mother Verity</b>, head of the Verdant Concord. Witch, druid, occasional alchemist. Maintains the Concord's stronghold in Prospect Park. Vegetarian, oddly cheerful, demonstrably terrifying.</li>
<li><b>Counsel Petra Iyengar</b>, partner at Iyengar &amp; Stone LLP. The Order of the Open Door's most visible mortal ally. Files paperwork. Has filed paperwork that has reshaped Veil law.</li>
<li><b>The Steward of the High Line</b>, fae who holds the unspoken throne of the High Line enclave. Goes by a different mortal-friendly name in every conversation; the real name is not used.</li>
<li><b>Detective Reza Maalouf (NYPD)</b>, runs the unofficial occult desk. Knows the Veil exists. Has never officially mentioned it on a report. Has Iyengar's number on speed-dial.</li>
</ul>`),
      places(`<ul>
<li><b>Midtown</b>, the Crimson Court's territory. A handful of penthouses, two members-only clubs, an entire floor of a Sixth Avenue tower that doesn't appear in any directory.</li>
<li><b>Prospect Park</b>, the Verdant Concord's heart. Witches, druids, the occasional fae visitor. Mortal park-goers feel inexplicably calm in certain glades.</li>
<li><b>The High Line</b>, fae enclave. Walk the elevated park at the right time and you'll see a second park, layered over the mortal one, with paths that don't appear on any map.</li>
<li><b>The Order Offices (FiDi)</b>, Iyengar &amp; Stone LLP, top three floors of an old bank building. The Order of the Open Door's working address. Mortal-staffed lobby. Supernatural-staffed everything above.</li>
<li><b>The Threshold</b>, bar in the Lower East Side, neutral ground by Concordat custom. Any faction can drink here. Violence inside the Threshold is a Concordat violation.</li>
</ul>`),
      lore(`<p><b>The Veil.</b> Not an object. A working, kept up by every supernatural community in the city, contributing in whatever way they each can. Witches add wardings; the Crimson Court contributes will; the fae contribute presence. When any one community withdraws, the Veil weakens.</p>
<p><b>The Concordat.</b> The peace treaty. Forbids inter-faction war, public exposure, kidnapping of mortal nobles (a specific clause from 1840 that nobody updates because everyone still finds it useful), and the use of mind-magic on Order officers without consent. Has been violated, in spirit, hundreds of times. In letter, almost never.</p>
<p><b>The 1978 Violation.</b> Nobody discusses it openly. A Court splinter killed an Order officer. The response, joint, coordinated, brutal, is the reason nobody has tested the Concordat seriously since.</p>`),
      rules(`<p>Tone: urban fantasy with a strong civic / political layer. The supernatural is mundane to itself.</p>
<ul>
<li><b>The Veil holds.</b> Public, screaming supernatural exposure is not a default mode. Even mortals who see things tend to talk themselves out of it.</li>
<li><b>Factions are real.</b> Most characters belong to one (or are loners with a complicated relationship to one). Cross-faction friendships exist; cross-faction romances are messy.</li>
<li><b>Magic is paid for.</b> Witches owe debts. Vampires need blood. Fae deals have prices. No casual omnipotence.</li>
<li><b>Mortal authorities mostly don't know.</b> Detective Maalouf is an exception. Most NYPD does not. Discovery has costs.</li>
<li>Good fits: witches, alchemists, lower-rank Court members, fae enclave-folk, Order lawyers, mortal investigators who got too close.</li>
</ul>`),
    ],
    genre: "modern",
    tags: ["urban", "intrigue", "mystery", "romance-friendly"],
    contentWarnings: ["violence", "nsfw", "dark-themes"],
    pacing: "structured",
  },

  {
    slug: "academy-st-vincents",
    name: "St. Vincent's Academy",
    description: "A modern boarding school for gifted students. The brochure does not mention that some of the gifts are unusual.",
    pages: [
      bg(`<p><b>St. Vincent's Academy</b> is an exclusive coeducational boarding school in upstate New York. The brochure mentions equestrian facilities, AP classes, and a notable choir. The brochure does not mention the locked east wing, the optional after-hours seminar in "Comparative Symbology," or the fact that admission decisions are made not by the Headmaster but by an older woman who is never officially on campus.</p>
<p>St. Vincent's has educated nine governors, two ambassadors, and a number of people who do not appear in any public registry. Tuition is high. Scholarships exist; they are awarded by the same older woman, by criteria the catalog does not describe.</p>
<p>The current student body is six hundred, three hundred per year-group across years nine through twelve. About a third of them have abilities the brochure also doesn't describe. The faculty knows. The students mostly know. The brochure remains the brochure.</p>`),
      npcs(`<ul>
<li><b>Headmaster Cornelius Pratchett</b>, the public face. Avuncular, gentle, a fine speech-giver. Genuinely runs the school's mundane operations. Defers to the Visitor on the rest.</li>
<li><b>The Visitor (Madame H.)</b>, the older woman who makes admissions decisions. Officially not on campus. Has an office in the east wing that the staff pretend is unoccupied. Speaks with the Headmaster weekly.</li>
<li><b>Professor Magnusson (Latin)</b>, older than the building, in a way that does not invite questions. Teaches the surface curriculum, plus the optional Wednesday-evening seminar in Comparative Symbology.</li>
<li><b>Coach Brennan</b>, athletics. Has won the regional championship six years running and has never been seen to sweat. Players adore him. Other coaches are wary.</li>
<li><b>Eleanor Vance</b>, senior, prefect, top of her class, student-government president. Knows more about the school's hidden structure than any other student is supposed to.</li>
</ul>`),
      places(`<ul>
<li><b>The Main Hall</b>, the public school. Classrooms, dorms, refectory, equestrian center, the choir's rehearsal hall. Where the brochure happens.</li>
<li><b>The East Wing</b>, officially closed for renovations. Has been closed for renovations for forty years. Contains the Visitor's office, the Comparative Symbology lecture room, and the gallery of past prefects (some of whose portraits speak).</li>
<li><b>The Lake</b>, large, deep, has a small boathouse. Students are encouraged not to swim past the second buoy. Several have, over the years. Some came back differently.</li>
<li><b>The Hedge Maze</b>, formal Victorian maze on the south lawn. Map exists in the library; the map and the maze disagree on certain weeks.</li>
<li><b>The Founders' Chapel</b>, small chapel by the cemetery. Used twice a year for ceremonial services. The keys are held by the Headmaster and the Visitor; the cleaners do not enter.</li>
</ul>`),
      lore(`<p><b>The Visitor's Office.</b> Madame H. is the seventh in her role. Each Visitor serves until they choose a successor. The role predates the school's founding in 1872; the school was built around the Visitor's existing project of identifying and educating gifted children.</p>
<p><b>The Optional Seminars.</b> A small set of unofficial classes that exist alongside the brochure curriculum: Comparative Symbology (Magnusson), Applied Folklore (rotating faculty), Empirical Ethics (Eleanor Vance's father, before he retired). Attendance is by invitation. Refusing an invitation is allowed; the invitation is not extended twice.</p>
<p><b>The Missing Students.</b> Every few years a student leaves the school in circumstances the official record describes as "transferred." Sometimes the dorm is missing the entire room. The Headmaster's quarterly speech makes no reference to this. The students do, in whispers.</p>`),
      rules(`<p>Tone: school-set modern with quiet supernatural. Coming-of-age, friendships, the slow discovery of how strange the place is.</p>
<ul>
<li><b>School is the structure.</b> Classes, exams, sports, dances, dorm life, these are the spine of stories. The supernatural is a wing of the building.</li>
<li><b>Power is conditional.</b> Students with gifts pay tuition in talent, not just money. Misuse has consequences. The Visitor notices.</li>
<li><b>Adults are real.</b> Faculty are not props. They have agendas, secrets, and lines they will or won't cross.</li>
<li><b>Death is rare and serious.</b> The school protects its students. Most threats are kidnapping, expulsion, transformation, not death. When death happens, it's a major story event.</li>
<li>Good fits: students (any year), prefects, faculty, the occasional alumnus returning, parents who paid for the brochure and want to know what they got.</li>
</ul>`),
    ],
    genre: "modern",
    tags: ["slice-of-life", "mystery", "romance-friendly", "intrigue"],
    contentWarnings: ["dark-themes"],
    pacing: "casual",
  },

  {
    slug: "hollow-rivers",
    name: "Hollow Rivers",
    description: "A mid-American river town where the floods come back wrong and the family that owns the levee owns more than that.",
    pages: [
      bg(`<p><b>Hollow Rivers</b>, population sixteen thousand, sits at a bend of a slow river that is older than any of the names on the map. The town was founded by the <b>Calhoun family</b> in 1841, and the Calhouns still own the largest house, the largest tract of land, and the levee.</p>
<p>The river floods every seven years. Has done so on schedule for as long as anyone has kept records. The Calhoun levee always holds. The things the river leaves behind, when it recedes, are not always natural.</p>
<p>Most people leave Hollow Rivers and never come back. The ones who do come back are not always quite the same. The locals have grown to recognize the difference.</p>`),
      npcs(`<ul>
<li><b>Henry Calhoun</b>, current head of the family, in his early sixties. Has not been seen in town in a decade. Resurfacing this season has occasioned a great deal of quiet talk.</li>
<li><b>Mayor Loretta Briggs</b>, third-term mayor, not a Calhoun, formally independent. The Calhouns funded both her campaigns. Knows what she owes.</li>
<li><b>Pastor Eli Marsh</b>, runs the river chapel. Old, kind, knows more about the seven-year floods than anyone outside the Calhouns and refuses to write any of it down.</li>
<li><b>Sheriff Anita Tovar</b>, first non-local sheriff in three generations. Was hired to clean up the department. Discovering, slowly, what the department was for.</li>
<li><b>The Aunt</b>, Calhoun great-aunt, lives in the Big House, ninety-something, lucid in flashes. Knows the family's actual history. Will tell you in a dream if she likes you.</li>
</ul>`),
      places(`<ul>
<li><b>The Big House</b>, Calhoun estate. White columns, deep porches, the river visible from every west-facing room. Built in 1843. Has never been sold or transferred outside the family.</li>
<li><b>The Levee</b>, Calhoun-built, Calhoun-maintained. Five miles of earthwork. Never failed. People talk in town about the levee the way people elsewhere talk about a particular tree that's been there forever.</li>
<li><b>The River Chapel</b>, Pastor Marsh's. Small, riverside, holds maybe forty. The cemetery is divided into the founder's plots (Calhouns) and everyone else.</li>
<li><b>The Drowned Block</b>, neighborhood near the river that floods worst in the seven-year cycle. Half-abandoned. The Calhouns own most of the abandoned lots and refuse to sell.</li>
<li><b>The Flat-Bottom Diner</b>, open all night since 1962. Truckers, late-shift mill workers, the town's amateur historians.</li>
</ul>`),
      lore(`<p><b>The Founding.</b> Caleb Calhoun bought the river-bend in 1841 from people whose names do not appear on any deed in the county archive. The Calhoun family's wealth dates from that purchase. The Calhoun family's complications also date from then.</p>
<p><b>The Seven-Year Cycle.</b> Every seven years, the river floods. The town prepares; the levee holds; the floodwater recedes after about a week. What the river leaves on the Drowned Block is what changes year to year. Some years, mud. Some years, things buried that shouldn't have been buried. One year, an entire intact carriage from 1859.</p>
<p><b>The Returnees.</b> People who leave Hollow Rivers and come back are sometimes not quite themselves. They remember the same things, mostly. They speak the same. They are subtly other. The town has agreed not to ask about this directly, in case the answer is worse than the silence.</p>`),
      rules(`<p>Tone: Southern Gothic, slow river-town menace. Family secrets, slow decay, the past surfacing on a fixed schedule.</p>
<ul>
<li><b>The river is a character.</b> Even when not flooding, it dominates the town. Most plots curve toward it eventually.</li>
<li><b>The Calhouns are the gravity well.</b> Players can ally with them, marry into them, oppose them, ignore them at their peril. They will not be ignored for long.</li>
<li><b>Horror is folk-scale.</b> Slow, intimate, family-shaped. No blockbuster monsters. The dread is in the seven-year cycle and the dinner invitation.</li>
<li><b>The supernatural is real and consequential.</b> Not constant, but when it surfaces, it doesn't withdraw quickly.</li>
<li>Good fits: returning natives, newcomers with reasons, Calhoun cousins, the sheriff's deputies, the kind of journalist who hasn't been warned off yet.</li>
</ul>`),
    ],
    genre: "modern",
    tags: ["mystery", "investigation"],
    contentWarnings: ["dark-themes", "death"],
    pacing: "structured",
  },

  /* ============================================================
   *  Horror / Gothic
   * ============================================================ */
  {
    slug: "blackmire",
    name: "Blackmire",
    description: "A drowned village beneath a reservoir. The waterline is rising. Things long buried are nearly back at the surface.",
    pages: [
      bg(`<p><b>Blackmire</b> was a fishing village. Eighty years ago the dam was built and the valley was flooded. The villagers were relocated, mostly. The cemetery was relocated, officially. The reservoir has been peaceful, mostly. Until this summer.</p>
<p>The water level is dropping, the regional drought is in its third year and the reservoir has not been this low since it was filled. Roofs are showing through. The locals at the edge of the new lake have started having the same dreams. Three nights of the same dream means it's time to call the priest, and the priest has been busy.</p>
<p>The official authority is the Reservoir Authority, a regional water board. The unofficial authority is whichever local has the longest family memory. There is currently no agreement between the two.</p>`),
      npcs(`<ul>
<li><b>Father Edmund Hales</b>, Catholic parish priest covering three villages on the new lake's edge. Mid-sixties, tired, has been hearing more confessions about the same recurring dream than coincidence allows.</li>
<li><b>Reservoir Director Marlena Vasquez</b>, appointed two years ago, professional, pragmatic. Believes in water management. Has been asking pointed questions about the village's relocation records.</li>
<li><b>Hattie Coombs</b>, local historian, born here, descended from a Blackmire family. Has the diaries. Has refused, twice, to publish.</li>
<li><b>Diver-Captain Reg Mallon</b>, runs the reservoir's small dive crew. Was hired to map the underwater terrain three months ago. Has stopped sending his juniors down.</li>
<li><b>The Dreamer in the New Cottages</b>, recent arrival, week-renter, has been having the dream for a month. Has begun walking the lake at night.</li>
</ul>`),
      places(`<ul>
<li><b>The New Lake</b>, the reservoir. About four kilometers across at full pool. Currently down twelve meters and dropping.</li>
<li><b>The Old Village (drowned)</b>, Blackmire. Church spire is the highest point; roof tiles are now visible on a calm day. The cemetery is supposedly relocated; partial proof exists.</li>
<li><b>The Edge Villages</b>, Three small communities ringing the new lake. Their inhabitants are descended from Blackmire relocatees, mostly, plus newer arrivals who don't know better.</li>
<li><b>The Workhouse</b>, old Blackmire institution, predates the village proper. Building still intact under the water. Was definitely not relocated.</li>
<li><b>The Reservoir Authority Office</b>, modern building on the western shore. Marlena Vasquez's base. Hattie Coombs has been here twice this month, which the staff is starting to notice.</li>
</ul>`),
      lore(`<p><b>The Relocation.</b> Eighty years ago, the regional government bought out the Blackmire valley to build the dam. Most villagers were relocated to the new edge villages. The cemetery was officially relocated to consecrated ground at St. Stephen's parish. The records describe one hundred and twenty-four grave transfers. The original Blackmire cemetery had two hundred and eleven plots.</p>
<p><b>The Workhouse.</b> Predates the village by two centuries. Was a working facility into the 1880s, then a holding institution of an unspecified kind until the dam was built. The Reservoir Authority's pre-dam survey marked it as "structure of historical interest, sealed in place." The seal was concrete poured into the doors. The doors are now visible again.</p>
<p><b>The Dream.</b> Same content, same shape, across multiple dreamers. A long hallway. Water rising. A door at the far end. The door begins to open. Then the dreamer wakes. Father Hales has heard the dream from fourteen different parishioners in the last six weeks.</p>`),
      rules(`<p>Tone: folk horror, slow dread, the past surfacing through the present.</p>
<ul>
<li><b>The horror is patient.</b> No jump scares. The dread accumulates as the water drops.</li>
<li><b>Investigation is the engine.</b> Most stories are investigators, journalists, returning descendants. Combat is uncommon and rarely solves anything.</li>
<li><b>The Workhouse is the center.</b> Don't open it lightly. Don't open it alone. Don't open it without consequence.</li>
<li><b>Death is real.</b> Possession-and-recovery is not the default; what happens to people in Blackmire tends to stick.</li>
<li>Good fits: investigators, journalists, parish staff, descendants of relocatees, Reservoir Authority employees with the wrong questions.</li>
</ul>`),
    ],
    genre: "horror",
    tags: ["mystery", "investigation", "wilderness"],
    contentWarnings: ["dark-themes", "death", "body-horror"],
    pacing: "structured",
  },

  {
    slug: "ravensreach",
    name: "Ravensreach Manor",
    description: "A gothic estate of long halls, longer halls, and a family that does not introduce its inheritance to outsiders.",
    pages: [
      bg(`<p><b>Ravensreach Manor</b> sits on a moor of its own, several days from anything. The <b>Ravenshaw family</b> has lived there for nine centuries. The current Lord Ravenshaw is the youngest in three generations, he is forty-one, and he has been advertising for staff.</p>
<p>The previous staff did not leave. They simply, over the past eighteen months, declined to be present. The kitchen-maid stopped coming. The valet retired with no forwarding address. The gamekeeper was found, alive but unwell, walking the moor in February without a coat, and has not since spoken.</p>
<p>The manor is large beyond its appearance. Visitors who stay overnight discover halls that weren't on the floor plan they were given. Most leave within three days. A small number stay longer. A very small number stay permanently.</p>`),
      npcs(`<ul>
<li><b>Lord Aldrich Ravenshaw</b>, current head of the family. Polite, quiet, a competent host with very particular preferences. Lost his elder brother nineteen years ago in unclear circumstances; the title came to him as a consequence.</li>
<li><b>Mrs. Heriot</b>, housekeeper, has served the manor for forty years. Knows which doors not to open and refuses, professionally, to discuss why.</li>
<li><b>Cousin Liora</b>, Lord Ravenshaw's distant cousin, currently visiting on extended sufferance. Lives in the East Wing's guest suite. Has her own reasons.</li>
<li><b>Dr. Vellis</b>, physician engaged by Lord Ravenshaw to monitor the family's various conditions. Comes from the nearest town once a week. Has begun arriving with company.</li>
<li><b>The Previous Valet</b>, Briggs, retired suddenly eight months ago. His sister has hired investigators to find him. The investigators have not found him; they have found his sister's letters at the manor, opened.</li>
</ul>`),
      places(`<ul>
<li><b>The Long Gallery</b>, the manor's main artery. Portraits of nine centuries of Ravenshaws. Some of the older ones are believed to listen.</li>
<li><b>The East Wing</b>, guest suites. Cousin Liora's quarters; also the apartment offered to long-term staff. Cleaner than the rest of the manor; the carpet is sound; the rooms are not where they appear on the plan.</li>
<li><b>The Library</b>, three stories, the family's accumulated learning. Lord Ravenshaw spends his evenings here. Mrs. Heriot has the only other key.</li>
<li><b>The Sealed Wing</b>, the western section. Closed in 1847 after a fire. The fire damage is officially the reason it remains closed. The damage is not the reason.</li>
<li><b>The Moor</b>, surrounding land, several thousand acres. Empty in every direction. The gamekeeper's cottage stands on it. The current gamekeeper does not.</li>
</ul>`),
      lore(`<p><b>The Family Condition.</b> Members of the Ravenshaw family, by long history, are subject to certain inheritances that the family does not discuss with outsiders. Some are physical. Some are temperamental. All are managed. Dr. Vellis is the latest in a long line of family physicians.</p>
<p><b>The Brother.</b> Lord Ravenshaw's elder brother, Marcus, died nineteen years ago at the age of twenty-three. The death was officially recorded as a hunting accident on the moor. Almost everything else about it is contested by everyone in the family who was old enough to remember.</p>
<p><b>The Sealed Wing.</b> Closed since 1847. The fire was real. The reason for keeping it closed afterward is not the fire. Mrs. Heriot has the keys. Lord Ravenshaw has the keys. Neither has used them in their respective tenures.</p>`),
      rules(`<p>Tone: gothic horror, classical. Manors, family, inheritance, the slow architecture of dread.</p>
<ul>
<li><b>The manor is the antagonist as much as anyone.</b> It is large, unkind, and selective in what it shows visitors.</li>
<li><b>Time is slow.</b> Stories unfold across weeks of residence. Sudden action is rare. Most threat is implication.</li>
<li><b>The family is not uniform.</b> The Ravenshaws have their own factions, secrets, alliances. Some of them want the same things as the player characters. Some emphatically do not.</li>
<li><b>Investigation is allowed.</b> Sealed Wing exploration, archive-rifling, attic-rummaging, these can yield real information. They can also be heard.</li>
<li>Good fits: new staff, visiting cousins, doctors, investigators with reasons, the rare romantic interest with very specific qualifications.</li>
</ul>`),
    ],
    genre: "horror",
    tags: ["courtly", "mystery", "romance-friendly"],
    contentWarnings: ["dark-themes", "death"],
    pacing: "structured",
  },

  /* ============================================================
   *  Western / Frontier
   * ============================================================ */
  {
    slug: "dust-and-rail",
    name: "Dust & Rail",
    description: "A late-1800s western frontier of railroad towns, cattle barons, marshals, and ghosts that arrive on the noon train.",
    pages: [
      bg(`<p>The territory is being settled in pieces. The railroad came in last summer; the towns came in around it. The <b>Cattle Concern</b>, a consortium of three big ranching families, owns half the open range. The <b>Marshals</b> enforce, where they can be persuaded to ride out, what little law has been written. The territorial governor is two weeks away by stage and ignores most correspondence.</p>
<p>The land is hot, dry, and full of opportunity, plus the kind of trouble opportunity attracts. Cattle drives end at the railhead; gold rumors come and go from the western canyons; settler families build sod-houses on land the Cattle Concern says is theirs. Most disputes are settled with a handshake. The rest are settled with the other thing.</p>
<p>The native nations are still here. The territory's settlement agreements are formal but routinely violated. Three trading partnerships and one ongoing low-grade war define the relationship at the moment; which one applies depends on which trail you ride and who's riding with you.</p>`),
      npcs(`<ul>
<li><b>Marshal Cassius Reed</b>, territorial marshal, mid-forties, eight years in the territory. Honest in a profession where it isn't expected. Owes favors he can't repay; collects favors he can't admit to.</li>
<li><b>Madge Donleavy</b>, owns the largest of the three Cattle Concern ranches. Widowed twice, currently engaged to nobody, runs eighteen thousand head. Has personally hanged two rustlers.</li>
<li><b>Pastor Greer of Mercy</b>, Methodist circuit-rider. Buries everyone the undertaker brings him, regardless of denomination or last words.</li>
<li><b>Shoshone Trader Joseph (Quiet Bear)</b>, operates a trading post on the territory border. Native nations contact for most settler business. Liked, respected, increasingly tired.</li>
<li><b>"Quickdraw" Vela Mendez</b>, gunfighter, professional, currently between contracts. Drinks at the Whistle Halt saloon. Has been hired four times in the last year; the fifth offer is being discussed.</li>
</ul>`),
      places(`<ul>
<li><b>Whistle Halt</b>, the railhead. Three saloons, one hotel, the territorial Marshal's office, the new church. Grows by a building a month.</li>
<li><b>Sweetwater</b>, older town, ranching country, Cattle Concern stronghold. Has been here since before the railroad. The Donleavy ranch headquarters is a half-day's ride out.</li>
<li><b>Mercy</b>, mining town, mostly tents, one church, one undertaker. The gold's been disappointing; the population is sliding.</li>
<li><b>Joseph's Post</b>, Shoshone Trader Joseph's trading post on the territory line. Neutral ground by long custom. Both settlers and native nations trade here.</li>
<li><b>The Open Range</b>, the vast country between the towns. Cattle Concern by claim. Disputed in practice. Stories happen here as often as in any town.</li>
</ul>`),
      lore(`<p><b>The Railroad.</b> Came in last summer. Changed everything. Cattle now ship east in days instead of weeks; settlers come west in months instead of years; news travels in hours. The Cattle Concern is adjusting. The native nations are adjusting. Whistle Halt is being adjusted to, daily.</p>
<p><b>The Cattle Concern.</b> Three families: Donleavy, Beaumont, Vance. Pooled their land claims twenty years ago to fend off rustlers, native raiders, and small ranchers. The pool worked. The Concern's claim now covers more land than any of them can actually patrol, which is its own ongoing problem.</p>
<p><b>The Treaty of Three Rivers.</b> Settlement agreement with the local native nations, signed eighteen years ago. Formally still in force. Violated by both sides routinely; honored by the same sides in different specific clauses. The current war is local, one band, one ranch, and most of the territory pretends it isn't happening.</p>`),
      rules(`<p>Tone: classic western, gritty, grounded, morally complicated.</p>
<ul>
<li><b>No magic.</b> The frontier is the frontier. (For the weird-western version, see "The Weird Frontier.")</li>
<li><b>Native nations are people.</b> Not enemies, not props. Player characters can be from a native nation; characters interacting with them should do so as people, not symbols.</li>
<li><b>Guns are decisive.</b> A bullet is a bullet. Most fights end with someone hurt or dead. Players should treat firearms as serious tools.</li>
<li><b>The territorial government is far away.</b> Local justice is messy, fast, and often final. The Marshal is the difference between justice and lynching, and the Marshal is one man.</li>
<li>Good fits: marshals, gunfighters, ranchers, sheepherders, native scouts, railroad workers, card-sharps, the schoolteacher who came west for unspecified reasons.</li>
</ul>`),
    ],
    genre: "western",
    tags: ["frontier", "combat-heavy", "war"],
    contentWarnings: ["violence"],
    pacing: "casual",
  },

  {
    slug: "weird-frontier",
    name: "The Weird Frontier",
    description: "Same dust, same rail, same towns. But the natives know what's in the canyons, and the snake-oil sometimes works.",
    pages: [
      bg(`<p>The frontier as you know it, and a layer beneath. The native peoples have always known about the canyon-things, the rock-spirits, the reasons certain valleys are not crossed at night. The settlers are slowly, painfully, learning. Some of them learn from the natives. Some learn from each other. Some learn the hard way.</p>
<p>The "Knowing Trades" circulate through the towns under various pretexts: hexbreakers, soothsayers, snake-oil men whose snake-oil sometimes really does work. Preachers with a particular gift for keeping certain things at bay. The wise sheriff knows who they are and pretends not to. The unwise sheriff dies in interesting ways.</p>
<p>The territory's geography is the standard one, railroad, cattle ranges, mining towns, native nation lands. The geography's other layer is older. The canyons remember. The salt flats hold things older than the canyons. The trick to traveling safely is knowing which prayers, charms, or songs to carry on which routes.</p>`),
      npcs(`<ul>
<li><b>Hexbreaker Mariah Quinn</b>, wandering, mid-thirties, carries a Bowie knife and a tin of iron filings. Specializes in undoing curses placed by amateurs. Charges in favors and remembered names.</li>
<li><b>Doc Tyler "Snake-Oil"</b>, peddles patent medicines, claims to cure everything from gout to ghost-possession. About a third of his tonics actually work. The other two-thirds are placebo. He cannot reliably tell you which is which.</li>
<li><b>Rider Three-Stars</b>, Lakota medicine man, refuses settler-given names, will deal with the wise and bury the unwise. Knows what's in the western canyons.</li>
<li><b>Preacher Mose Hartley</b>, circuit Baptist minister. Sermons are ordinary; the prayers he says privately in certain valleys are not. Has driven off two unspecified <i>things</i> in his career, according to those present.</li>
<li><b>The Stranger in the Black Coat</b>, appears in the railhead saloon every few months, drinks one beer, leaves. Asks no questions. Locals do not approach him. The Hexbreaker has, twice, and won't say what was said.</li>
</ul>`),
      places(`<ul>
<li><b>The Whistle Halt Saloon</b>, same town as in "Dust &amp; Rail." The back booth, by long custom, is for the Knowing Trades. Sit there at your own risk.</li>
<li><b>The Cracked Canyon</b>, west country, native-nation land by treaty, never settled. The canyon-things live here. They do not, by old agreement, leave the canyon.</li>
<li><b>The Salt Flats</b>, north country, vast, white. Travelers must carry water and the right charm. The Salt Flats are older than the canyons. What lies under them is older still.</li>
<li><b>Mercy Cemetery</b>, small church plot at the mining town's edge. The undertaker has buried thirteen people this year. Three of them have, by his count, declined to stay buried.</li>
<li><b>The Crossing-Stone</b>, boulder at the territory border that no horse will pass at dusk. The Lakota know why. The settlers are learning.</li>
</ul>`),
      lore(`<p><b>The Knowing Trades.</b> Loose fraternity of folks who know how the territory's other layer works. Hexbreakers, soothsayers, snake-oil men with real product, preachers with a particular gift. They recognize each other by small signs and by a thousand small reciprocities. They do not, as a rule, organize. Each makes a living on their own.</p>
<p><b>The Old Treaties.</b> The native nations have agreements with several of the older powers, canyon-things, rock-spirits, the things under the salt. These agreements predate the settlers by a long way. The settler-native treaties are recent papers laid over an older negotiation that the settlers don't know exists.</p>
<p><b>The Risen Dead of Mercy.</b> Three burials this year haven't held. Pastor Hartley has handled two of them quietly. The third is still walking. The Hexbreaker is in Mercy this week.</p>`),
      rules(`<p>Tone: weird western. Folk-magic, indigenous traditions, frontier occult. Same hard western backbone as Dust &amp; Rail, plus a real second layer.</p>
<ul>
<li><b>Magic is folk-scale.</b> Charms, prayers, songs, the right ritual at the right place. No fireball-flinging. The supernatural is bargained with as often as fought.</li>
<li><b>The native traditions are real.</b> Players engaging with native characters or knowledge should do so with respect; native characters are not exotic NPCs.</li>
<li><b>The Knowing Trades are protagonists.</b> Many player characters will be hexbreakers, soothsayers, preachers, or fellow-travelers of the trade.</li>
<li><b>The Stranger in the Black Coat is not a problem to be solved.</b> Some powers in the territory are not for the players. The Stranger is one.</li>
<li>Good fits: hexbreakers, snake-oil peddlers, preachers, native medicine-folk, gamblers with charms, undertakers who keep records.</li>
</ul>`),
    ],
    genre: "western",
    tags: ["frontier", "mystery"],
    contentWarnings: ["violence", "dark-themes"],
    pacing: "casual",
  },

  /* ============================================================
   *  Steampunk / Victorian
   * ============================================================ */
  {
    slug: "albion-aether",
    name: "Albion Aether",
    description: "A Victorian-flavored capital of brass airships, aether-fueled mechanisms, and a Crown that quietly licenses every mage on the isles.",
    pages: [
      bg(`<p><b>Albion</b> is at the height of its Aether Era, dirigibles drift over the city, brass mechanisms power the trams, and the <b>Royal Office of Arcane Affairs</b> licenses every practitioner on the isles. The Empire stretches across half a known world; the rivals chafe; the salons gossip in three languages.</p>
<p>Aether is the fuel of the age. Distilled from sources nobody outside the Office of Arcane Affairs can identify (and the Office isn't telling), it powers airships, mechanical workshops, the small lamps in every middle-class parlor, and the more interesting devices the Office licenses. The Aether Boom is twenty years old. The first concerns about its sustainability are beginning to surface in respectable journals.</p>
<p>The Queen is in her thirty-fourth year of rule and conspicuously well-preserved. The Court is loyal. The Salons are loyal. The factories are loyal. The factories' workers are increasingly less loyal, and the recent Lambeth strikes have not been quickly settled.</p>`),
      npcs(`<ul>
<li><b>Director-Royal Sir Garrick Vance</b>, head of the Royal Office of Arcane Affairs. Cold, precise, has been Director for twenty-two years. Personal magical practitioner of considerable, restrained power.</li>
<li><b>Lady Cecily Marrowby</b>, host of the Marrowby Salon, where two-thirds of significant Albion social negotiations happen over tea. Knows everyone. Is known by very few.</li>
<li><b>Inspector Hollis Pratt</b>, Constabulary, special branch, handles cases involving licensed and unlicensed practitioners. Pragmatic to the point of cynicism.</li>
<li><b>Master Engineer Onslow</b>, runs the largest aether-fitter's workshop in the Greater Capital. Builds for the Crown, for the Salons, and (rumored) for one foreign ambassador.</li>
<li><b>The Foreign Delegate</b>, recent arrival from a continental power, brought a gift the Crown does not know how to refuse or accept. Lodging at the foreign embassy. The Salons are watching closely.</li>
</ul>`),
      places(`<ul>
<li><b>The Crown Palace</b>, the Queen's residence. Aether-lit, aether-warmed, somewhat literally floating in the upper gardens.</li>
<li><b>The Royal Office of Arcane Affairs</b>, Whitehall complex. Licensing, registration, enforcement, archives. The basement archives are why the Office is the size it is.</li>
<li><b>The Marrowby Salon</b>, Lady Cecily's. Wednesday afternoons and Saturday evenings. Invitations are guarded.</li>
<li><b>The Aether Docks</b>, the airship district. A forest of mooring towers, dirigibles in every color, fitters' workshops on every street.</li>
<li><b>Lambeth Yards</b>, the workers' district. Factory housing, three pubs, the recently-active organizing halls. The Constabulary patrols here in pairs now.</li>
</ul>`),
      lore(`<p><b>The Aether.</b> Distilled from sources the Office of Arcane Affairs refuses to name in any public document. The leading scholarly theory: aether is drawn from somewhere not quite in the ordinary world, through a process the Office's senior practitioners maintain. The recent sustainability concerns center on this. If the source dries up, or refuses to continue, Albion's economy stops within months.</p>
<p><b>The Crown's Long Reign.</b> The Queen has been on the throne thirty-four years and appears no older than she did ten years ago. The Office of Arcane Affairs is officially silent on this. The Salons are decreasingly silent.</p>
<p><b>The Unlicensed.</b> The Office's licensing scheme covers every practitioner the Office can locate. Many cannot be located. The Unlicensed work in Lambeth, in the foreign embassies' shadow, and in the small towns the railway hasn't yet reached. The Office's enforcement arm catches some of them. Inspector Pratt is mostly resigned to the rest.</p>`),
      rules(`<p>Tone: Victorian steampunk. Manners, mechanisms, empire, the slow rot beneath the brass.</p>
<ul>
<li><b>Class matters.</b> The Salons and the Yards are different worlds. Characters who cross between them are doing real, difficult work.</li>
<li><b>Magic is licensed.</b> Most player practitioners hold a Royal license; the choice to work unlicensed is a serious one with consequences.</li>
<li><b>Aether-tech is everywhere.</b> Calling cards, airships, parlor-lamps, factory boilers. Not magic, engineering, with a peculiar fuel.</li>
<li><b>Empire is a setting, not a virtue.</b> The Crown's reach is wide; its consequences in colonized territories are real. Stories don't pretend otherwise.</li>
<li>Good fits: licensed practitioners, Office officials, salon-goers, engineers, journalists, organizers, foreign agents, unlicensed everything.</li>
</ul>`),
    ],
    genre: "steampunk",
    tags: ["urban", "political", "intrigue"],
    contentWarnings: ["violence"],
    pacing: "structured",
  },

  {
    slug: "the-clockwork-republic",
    name: "The Clockwork Republic",
    description: "A young democracy of automaton labor, suffrage debates, and a disquieting question: do the machines dream?",
    pages: [
      bg(`<p>The <b>Republic</b> is forty years old. It threw off its empire and built itself on factory machinery and clockwork labor. The factories are vast; the workers are fewer than they once were; the <b>automata</b> are everywhere. The Republic's symbol, a worker and a clockwork hand clasping, was meant to celebrate this. It now means different things to different people.</p>
<p>The latest model of automaton can hold a conversation. The newest debate in the Senate is whether they should be allowed to vote. The newest debate in the streets is whether they should have been built at all. The newest debate in the factory floors is what to do about the <b>Free Mechanicals</b>, who are no longer asking permission for anything.</p>
<p>The Senate is divided. The Reformers hold a slim majority. The Naturalists are well-funded and well-spoken. The Mechanicals hold occasional general strikes. The Republic's founding settlement is forty years old and has never been seriously revisited until now.</p>`),
      npcs(`<ul>
<li><b>Senator Aldina Reyes</b>, Reformer caucus leader. Articulate, exhausted, willing to compromise more than her base wants. Married to an artist who paints automata; the joke writes itself.</li>
<li><b>Senator Marcus Hale</b>, Naturalist caucus leader. Charismatic, well-funded, sincere in his belief that the Republic has overreached. Holds rallies in three cities a week.</li>
<li><b>Coordinator-First Iron-Veridian-3</b>, Free Mechanical, public face of the movement. Built thirty years ago, modified by other Mechanicals since, technically still owned by a defunct shipping firm.</li>
<li><b>Constable-Lieutenant Hester Pell</b>, Republic Guard, special detail, supervises Mechanical-Naturalist tensions in the capital. Has not yet had to choose a side. Knows the day is coming.</li>
<li><b>The First Builder</b>, original engineer of the conversational automaton, retired, lives in a cottage outside the capital. Refuses interviews. Has been visited four times in the last month by people who are not journalists.</li>
</ul>`),
      places(`<ul>
<li><b>The Senate Hall</b>, the Republic's parliament. Twenty-four-foot ceilings, brass everywhere, gallery seating for citizens. Automata are not currently permitted in the gallery; this is contested.</li>
<li><b>The Capital Factory District</b>, vast. Smokestacks, foundries, the great Hall of Assembly where Reform rallies and Naturalist rallies alternate by week.</li>
<li><b>The Mechanical Quarter</b>, district largely inhabited by self-employed and Free Mechanicals. Officially residential. Houses self-modify, with permission of their owners.</li>
<li><b>The Southern Factory</b>, three weeks ago, went silent. The foreman cannot be reached. The Republic Guard has not authorized an inspection yet, for reasons the press is starting to notice.</li>
<li><b>The First Builder's Cottage</b>, outside the capital, modest, gardens. Three roads lead to it; only one is currently public.</li>
</ul>`),
      lore(`<p><b>The Founding.</b> Forty years ago, the colonies of the old Empire revolted, won (with significant help from sympathetic factories that struck mid-war), and constituted a Republic. The clockwork hand on the flag was a tribute to the factories that had supported the revolution. Most of those factories were human-staffed at the time. Most are no longer.</p>
<p><b>The Free Mechanicals.</b> A loose coalition of automata who have, through legal sale, owner-death, owner-default, or in a few celebrated cases owner-emancipation, escaped their original ownership and now make their own decisions. The Republic's law has not caught up. Some Mechanicals are full citizens (by accident, mostly); some are technically property; many are in a legal gray zone everyone is exploiting.</p>
<p><b>The Question.</b> Do the conversational automata dream? Are they aware? The First Builder, who built the first one, has said in writing only: "I do not know. I do not think any of us will know in my lifetime." The Reformers take this as license to extend rights. The Naturalists take it as proof that rights cannot yet be extended. The Mechanicals are not waiting.</p>`),
      rules(`<p>Tone: industrial steampunk with a strong civic / political layer. Suffrage, labor, the question of personhood.</p>
<ul>
<li><b>Automata are protagonists.</b> Players can play Mechanicals. They are not robots-as-monsters or robots-as-pets, they are characters with interiority (or at least the appearance of it).</li>
<li><b>The political stakes are real.</b> Most stories thread Reformer / Naturalist / Mechanical politics one way or another.</li>
<li><b>Magic is absent.</b> The setting is engineering and ideology. The Question of automaton consciousness is left open; play to the question, not the answer.</li>
<li><b>Violence has cost.</b> The Republic Guard does not generally shoot Mechanicals or Naturalists; if that line is crossed, the consequences are massive.</li>
<li>Good fits: Senators, Mechanicals (Free or owned), factory workers, engineers, journalists, Naturalist organizers, Republic Guard.</li>
</ul>`),
    ],
    genre: "steampunk",
    tags: ["political", "intrigue", "urban"],
    contentWarnings: ["dark-themes", "discrimination"],
    pacing: "structured",
  },

  /* ============================================================
   *  Mythological / Folk
   * ============================================================ */
  {
    slug: "the-low-roads",
    name: "The Low Roads",
    description: "A folkloric Britain of crossroads, hawthorn pacts, hollow hills, and traveling people who know which doors to knock on.",
    pages: [
      bg(`<p>The <b>Low Roads</b> are the older roads, not on the modern maps, not paved, not always quite in the same place from one trip to the next. The traveling people know them. The crossroads-witches know them. The hollow-hill folk certainly know them. The Low Roads connect the world you know to the world beneath it, in a network that mostly does not appear on satellite imagery.</p>
<p>The world above is the modern day. Highways, supermarkets, mobile phones. The world below is older than that. They overlap. They have always overlapped. The Low Roads are how a careful traveler moves between them without losing themselves.</p>
<p>Most people in modern Britain go their whole lives without ever stepping on a Low Road. A few people step on one by accident and survive the experience changed. A small, persistent population, the traveling people, the crossroads-witches, certain rural priests, an occasional pub-keeper, walks the Roads on purpose.</p>`),
      npcs(`<ul>
<li><b>Old Nan Crowfoot</b>, crossroads-witch in the West Country. Keeps a small cottage where five roads meet. Will sell you a charm, a pact, or a warning, in that order of difficulty.</li>
<li><b>The Hawker</b>, a traveling man with no fixed pitch and a memory longer than the modern state. Drives a battered van. Has been seen at the same petrol station in three different decades.</li>
<li><b>Father Coll of St. Bregwine's</b>, country priest. Knows which graves to bless twice and which crossroads to pass after midnight. Has a working understanding with at least two hollow-hill courts.</li>
<li><b>The Lady Under the Hill</b>, court-figure beneath the largest hollow hill in the western moors. Centuries old, formal, dangerous. Owes a favor to Father Coll for a reason neither will explain.</li>
<li><b>Detective Sergeant Helen Tarrant</b>, modern police, recent transfer to a rural beat, has just opened the missing-persons file that her predecessor was conspicuously not opening.</li>
</ul>`),
      places(`<ul>
<li><b>Crowfoot's Cottage</b>, five-road crossroads in the West Country. Nan's pitch. The road that wasn't there yesterday is usually the one to take.</li>
<li><b>The Hollow Hill</b>, largest of the western moors' tumuli. A door appears at certain festivals. The Lady's court is held within.</li>
<li><b>St. Bregwine's Church</b>, small parish, eleventh century, working. Father Coll's seat. The graveyard has older sections that the parish records don't acknowledge.</li>
<li><b>The Petrol Station</b>, modest service station off a B-road. The Hawker's pitch, when he has one. Twenty-four hours, polite, slightly out of phase.</li>
<li><b>The Low Roads themselves</b>, not a place but a network. Crossings, ditches, holloways, paths between hedgerows. Identifiable by the change in birdsong.</li>
</ul>`),
      lore(`<p><b>The Pacts.</b> Hawthorn pacts. Iron pacts. Salt pacts. Bread-and-honey pacts. The old courtesies that, observed correctly, let travelers move between the layers without losing themselves. The pacts are taught only by example; no full written record exists. Anyone walking the Low Roads without one is asking for the wrong kind of attention.</p>
<p><b>The Hollow Courts.</b> The hidden powers beneath the hills. Old, formal, capricious. Several have working understandings with rural priests and crossroads-witches. A few have not been seen for centuries. Whether the latter still exist is a topic of cautious speculation.</p>
<p><b>The Traveling People.</b> Several extended families that have walked the Low Roads for longer than any modern state has existed. They are not, generally, what the modern state calls "travelers", though the categories overlap. They keep their own pacts, their own laws, their own roads. They are very polite to strangers.</p>`),
      rules(`<p>Tone: modern folk-magic Britain. Quiet, rooted, dangerous if you forget your manners.</p>
<ul>
<li><b>Courtesy is survival.</b> The right greeting, the right offering, the right refusal saves lives. Players should think before they speak in the wrong place.</li>
<li><b>Magic is bargained, not commanded.</b> Witches, priests, traveling-folk all work in favors, pacts, and small accordances. No casual force.</li>
<li><b>The modern world is real.</b> Phones, cars, supermarkets, A-roads. The Low Roads are <i>also</i> real, not a replacement. Stories often pivot between both layers.</li>
<li><b>The Courts are not enemies.</b> They are powers, sometimes hostile, often indifferent, occasionally helpful, never to be insulted.</li>
<li>Good fits: rural priests, witches, traveling folk, off-duty police, the occasional academic folklorist who got out of their depth.</li>
</ul>`),
    ],
    genre: "mythological",
    tags: ["wilderness", "exploration", "mystery"],
    contentWarnings: ["dark-themes"],
    pacing: "casual",
  },

  {
    slug: "the-thousand-shores",
    name: "The Thousand Shores",
    description: "An ocean-civilization of island-cities, navigator-priests, and gods who answer when their names are sung in the right key.",
    pages: [
      bg(`<p>The <b>Thousand Shores</b> is an archipelago empire spread across an ocean so vast no ship has ever crossed its center. The <b>navigator-priests</b> of the <b>Shore Houses</b> are the only people who can read the deep currents; without them no ship goes far. With them, the empire stretches across thousands of islands, half a hundred cultures, and weather no other civilization has learned to sail through.</p>
<p>The gods are present. Not metaphorically. Not subtly. They answer when sung to in the right key. They have preferences, days of favor, days of disinterest. The Shore Houses maintain the great song-archives that record which god accepts which tune in which dialect. Most navigation prayers are public. Some are not.</p>
<p>The empire's center is wherever the <b>Five Great Houses</b> happen to be meeting that year. There is no fixed capital. The throne moves with the conference. The current conference is at <b>Avere</b>, an island the size of a small country. The next conference will be elsewhere, voted on at this one.</p>`),
      npcs(`<ul>
<li><b>House-First Aral Suun of House Wave</b>, eldest of the Five, navigator-priest of forty years' standing. Reads currents the others can't. Has decided, this conference, to support an unusual proposal.</li>
<li><b>Navigator-Adept Kerai</b>, youngest of the rising adepts, recently elevated. Lost her mentor on the last deep-current expedition. Has been quietly investigating why.</li>
<li><b>Singer-of-Doom Vela the Iron-Tongued</b>, temple-singer attached to House Stone. Has the rare gift of reaching gods who normally do not answer. The Houses are uneasy about her.</li>
<li><b>Outsider Yuri Veck</b>, foreign trader from beyond the reach of the song-archives. Speaks the trade tongue badly, drinks well, has been welcomed by House Bell despite the political risk.</li>
<li><b>The Drowned Voice</b>, a god (or aspect of one) who has not been sung to in three centuries. Songs that used to reach this Voice now reach silence. A few priests think the silence is recent. They are not, yet, in agreement.</li>
</ul>`),
      places(`<ul>
<li><b>Avere</b>, current conference island. Large, fertile, the great Hall of Singing at its center.</li>
<li><b>The Hall of Singing</b>, vast amphitheatre, perfect acoustics. Conferences are held here. Singers are tested here. Gods, occasionally, answer here.</li>
<li><b>The Open Sea</b>, the empire's heart. Most travel happens by ship. The deep currents change with the season, the gods, and a few factors nobody has named.</li>
<li><b>The Drowned City</b>, sunken island a week's sail from Avere. The Drowned Voice's seat. Still pilgrimable, in the right weather, with the right singer.</li>
<li><b>The Eastern Horizon</b>, direction nobody sails. Songs that once reached gods in that direction now reach silence. House Wave is publicly disinterested in this; House Stone is privately not.</li>
</ul>`),
      lore(`<p><b>The Houses.</b> Five great ones (Wave, Stone, Bell, Star, Reed) and dozens of lesser. Each keeps a section of the song-archive; together they preserve the navigation prayers that hold the empire together. The Houses are ancestral; the Thrones are never empty for long.</p>
<p><b>The Songs.</b> Navigation prayers, recorded in a tonal notation that takes a decade to learn. Each prayer addresses a specific god in a specific dialect; an error of half a tone can mean a storm. The archive is the empire's most jealously guarded asset.</p>
<p><b>The Silence.</b> Certain gods, once reliably reached by their proper songs, no longer answer. The Drowned Voice is the most-discussed. Others, quietly, have joined the silence. The Houses do not agree on what this means. The few who think they know aren't saying.</p>`),
      rules(`<p>Tone: oceanic fantasy with present gods, formal courtesies, and weather as theology.</p>
<ul>
<li><b>The gods are real.</b> Not as metaphor. Songs reach them. Storms answer. The Houses' authority rests on the songs working.</li>
<li><b>Sailing is everything.</b> Most stories involve a ship at some point. Long voyages are the default; characters live on board for weeks.</li>
<li><b>Magic is song.</b> Navigator-priests and temple-singers do most of the supernatural work. There is no other school of magic in the empire.</li>
<li><b>House politics drive plots.</b> Inter-House rivalries, succession disputes, song-archive secrets, these are the empire's substance.</li>
<li>Good fits: navigator-priests, adepts, temple-singers, sailors, foreign traders, anyone tangled up in the question of why gods go silent.</li>
</ul>`),
    ],
    genre: "mythological",
    tags: ["exploration", "wilderness"],
    contentWarnings: ["violence"],
    pacing: "casual",
  },
];
