/**
 * Default worlds shipped on every install. The system user owns them all so
 * they survive admin churn. Visibility is "open" so they appear in the World
 * Catalog and any user can join them or attach them to rooms.
 *
 * The seed loop is keyed on (ownerUserId="system", slug) and refuses to
 * overwrite anything that already exists, so admins / users can edit a world
 * after it's seeded and their changes survive every redeploy. New worlds
 * added to this list show up on the next boot; renamed worlds will appear
 * alongside the original (intentional - we never silently mutate something
 * a human may have customized).
 *
 * Each world ships with 3-4 starter pages. Pages are also idempotent: we
 * only insert a page if the world had ZERO pages at seed time. As soon as
 * a user adds or edits a page, we leave the wiki untouched on subsequent
 * seeds. This keeps the worlds feeling lived-in for cold visitors while
 * still letting the community elaborate them.
 */

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
  /** Optional. We don't ship custom themes for the defaults - viewers see their own theme. */
  pages: SeedPage[];
}

const p = (slug: string, title: string, bodyHtml: string): SeedPage => ({ slug, title, bodyHtml });

export const DEFAULT_WORLDS: SeedWorld[] = [
  /* ============================================================
   *  Medieval & High Fantasy (5)
   * ============================================================ */
  {
    slug: "ironreach",
    name: "Ironreach",
    description: "A high-fantasy kingdom of granite holds, dragon-scarred valleys, and oaths older than the throne.",
    pages: [
      p("overview", "Overview", "<p>Ironreach is a mountainous kingdom whose people remember every promise. The High Hold sits atop a cliff that drinks the wind, and from there the Iron Crown rules five lesser holds bound by the Old Oath - a compact written into the stone itself, said to crack if ever broken.</p><p>Magic exists, but it is rare and largely the province of the Wardens, ascetics who study the old runes carved into mountain roots. Common folk respect them and fear them in equal measure.</p>"),
      p("the-five-holds", "The Five Holds", "<p>Each hold answers to the High Throne but governs its own valley.</p><ul><li><b>Stonewatch</b> - the war-hold, keeper of the southern pass.</li><li><b>Eldermere</b> - lake-country, ancient and political.</li><li><b>Blackvein</b> - mining hold, source of most of the kingdom's iron.</li><li><b>Thornhall</b> - forested borderland, dispute with the Wildwood Tribes is constant.</li><li><b>Greysend</b> - the cold, distant hold; rumored to harbor heresies.</li></ul>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Hard-edged classic fantasy. Loyalty, oath-bonds, and the weight of inherited duty. Lower-magic - a Warden's spell is an event, not a casual flourish. Politics is local and personal; betrayal of a sworn word is the worst thing a person can do.</p><p>Suitable for knightly RP, court intrigue, frontier patrols, and slow-burn family sagas.</p>"),
      p("hooks", "Common Hooks", "<p>Ideas to get characters tangled up:</p><ul><li>The Old Oath has begun to fracture - tiny cracks in the stone of the High Hold.</li><li>A Warden has gone missing in Blackvein with three apprentices.</li><li>Thornhall and the Wildwood Tribes are one incident from open war.</li><li>An exile claims to be the lost heir of Greysend, with a relic to prove it.</li></ul>"),
    ],
  },
  {
    slug: "vesperhold",
    name: "Vesperhold",
    description: "A walled city-state ringed by haunted moors. The bells chime three times when the dead are restless.",
    pages: [
      p("overview", "Overview", "<p>Vesperhold sits at the edge of the Pale Moor, a city-state that long ago made an unspoken bargain: build the walls high, keep the bells rung, and the things in the mist will mostly leave you alone. Mostly.</p><p>The Council of Five governs from the Lantern Spire. They are merchants, generals, and one very old priest who never speaks unless the Council is deadlocked.</p>"),
      p("the-pale-moor", "The Pale Moor", "<p>A vast peat-and-mist wilderness ringing the city. By day it is grey, melancholic, navigable. By night, lights drift between cairns and travelers go missing. The moor's old residents - the Pale Folk - are not hostile so much as <i>elsewhere</i>, and walking too long upon their paths makes a person hard to find again.</p>"),
      p("hooks", "Common Hooks", "<p>Reasons to be in Vesperhold:</p><ul><li>You came to claim an inheritance - a house in the moor-quarter, where house prices are suspiciously low.</li><li>The bells chimed three times last night. Twice in a week is rare. Twice in three days is unheard of.</li><li>A merchant has hired guards to escort an unmarked wagon out across the moor at dawn.</li></ul>"),
    ],
  },
  {
    slug: "thrice-crowned",
    name: "The Thrice-Crowned Realm",
    description: "Three rival kingdoms, one prophesied throne, and a hundred years of cold war waiting to thaw.",
    pages: [
      p("overview", "Overview", "<p>Centuries ago a single empire splintered into three crowns: <b>Aldermark</b>, <b>Vermillion</b>, and <b>Sunhollow</b>. The prophecy says one will reunite them. Each has, at one point or another, taken this very personally.</p><p>The Cold Compact, signed at Whitewater, has held for a hundred years. Trade flows. Embassies smile. Spies do not stop.</p>"),
      p("the-three-courts", "The Three Courts", "<p><b>Aldermark</b> - lawyerly, merchant-driven, ruled by an elected King-Speaker.</p><p><b>Vermillion</b> - chivalric, traditional, the only court where a knight's word still settles a dispute by blood.</p><p><b>Sunhollow</b> - mage-led, austere, suspicious of the other two and increasingly inward-looking.</p>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Political fantasy. Diplomacy on the surface, daggers underneath. Players make characters who have a court allegiance (or are pointedly without one). Religious tension over which crown holds the favor of the old gods.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A noble of Vermillion asks for safe passage through Aldermark; the contents of their carriage are not what was declared.</li><li>A Sunhollow mage has been seen at a Vermillion tournament, and she is not officially there.</li><li>The Cold Compact comes up for re-ratification next spring.</li></ul>"),
    ],
  },
  {
    slug: "wildemere",
    name: "Wildemere",
    description: "A frontier of green wilderness, druid-circles, and small holds scratched out between standing stones.",
    pages: [
      p("overview", "Overview", "<p>Wildemere is what was once a forgotten wilderness, now slowly settling. Druid-circles still hold the largest patches of forest under their warded peace; humans, half-folk, and stranger settlers carve small holds out of the in-between.</p><p>There is no king. There is the Moot - a yearly gathering at Standing Hollow where the holds, the circles, and the wandering folk argue about who owes whom what.</p>"),
      p("the-circles", "The Druid Circles", "<p>Five circles of old families and adopted students who tend the wild. They are not pacifists. They are not friends with each other either - the Hawthorn Circle and the Thornroot Circle have not spoken for nineteen years, since something at the Solstice no one will explain.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A new hold has appeared in the Briar without permission. The nearest circle is deciding whether to ask politely or burn it down.</li><li>A wandering bard claims to have spoken with a creature no circle will name.</li><li>The Moot is in two months. Everyone is trading favors now.</li></ul>"),
    ],
  },
  {
    slug: "dawnvault",
    name: "Dawnvault",
    description: "A city built around a buried temple where the sun is said to sleep. Pilgrims come. Some leave changed.",
    pages: [
      p("overview", "Overview", "<p>Dawnvault grew up around the Sealed Temple - a buried complex older than any standing wall, where the priesthood claim a sleeping aspect of the sun lies dreaming. Whether or not this is true, the city makes good money on pilgrims who believe it.</p><p>The Hierarch rules from the Lantern Tier. The Temple Guard rules in fact.</p>"),
      p("the-sealed-temple", "The Sealed Temple", "<p>Vast, descending, partly mapped. Pilgrims walk the upper rings. Acolytes walk the middle. The lower rings are where Hierarchs go to die, and where, occasionally, novices are sent and do not return.</p>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Theocratic fantasy with a dungeoncrawl underbelly. Pilgrimage, faith, doubt, the politics of priesthood. Suitable for paladins, heretics, scholars, and the merchants who feed them all.</p>"),
    ],
  },

  /* ============================================================
   *  Feudal Japan / Eastern Fantasy (3)
   * ============================================================ */
  {
    slug: "tsukikage",
    name: "Tsukikage",
    description: "Feudal-era mountain provinces where yokai walk old roads and a samurai's sword is rarely the strangest thing on it.",
    pages: [
      p("overview", "Overview", "<p>Tsukikage - the Moonshadow provinces - are a series of mountain valleys where the old spirits never quite left. Villages sit in the folds; samurai families hold the passes; yokai walk the roads after dusk, sometimes harmless, sometimes not.</p><p>The Imperial Court sits far away. The local lords (daimyo) rule in practice, often with one eye on each other and one eye on what walks under the moon.</p>"),
      p("yokai-and-spirits", "Yokai &amp; Spirits", "<p>Yokai are everywhere and varied: mischievous, malevolent, lonely, ancient. The Yamabushi monks of Mount Tetsu maintain wards and treaties with many of them. A traveler who knows the right offerings often passes safely; one who doesn't, often doesn't.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A masterless samurai has been hired to escort a courtesan along the Moon Road in autumn.</li><li>A village reports that the kitsune-shrine has gone silent for the first time in living memory.</li><li>A daimyo's youngest son returns from the capital, accompanied by a foreigner no one can quite place.</li></ul>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Inuyasha-adjacent - feudal Japan with one foot in the spirit world. Honor, duty, doomed romance, the weight of family obligation. Combat is meaningful and rarely casual. Magic is folklore, not engineering.</p>"),
    ],
  },
  {
    slug: "the-jade-court",
    name: "The Jade Court",
    description: "A courtly capital of silken intrigue, ancestor halls, and dragons who occasionally remember they are dragons.",
    pages: [
      p("overview", "Overview", "<p>The Jade Court is the seat of the Celestial Dynasty - a vast, ancient empire whose capital is a city of silk, lacquer, and a thousand small ceremonies. Every gesture means something. Every silence means more.</p><p>The Empress sits on the Jade Throne. She is reputed to be over two hundred years old. Court astrologers do not contradict this, at least not in writing.</p>"),
      p("the-six-ministries", "The Six Ministries", "<p>Rites. Revenue. War. Justice. Works. Personnel. Each is a small kingdom of its own, with its own grudges, its own promotions, its own cells of secret loyalty.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A scholar's exam ranking has been suspiciously revised after the fact.</li><li>An old dragon has been sighted circling the eastern peaks - the first such sighting in seventy years.</li><li>An ambassador from the steppe has arrived and refuses to remove his weapons in court.</li></ul>"),
    ],
  },
  {
    slug: "ashigara-coast",
    name: "Ashigara Coast",
    description: "Storm-battered fishing villages, sword-saints in self-imposed exile, and pirate fleets who claim ancestral grudges.",
    pages: [
      p("overview", "Overview", "<p>The Ashigara Coast is a string of fishing villages and small ports along a stretch of sea-cliff country. The land is poor; the fishing is excellent; the pirates of the Storm Isles are, depending on the season, either visitors or invaders.</p>"),
      p("the-storm-isles", "The Storm Isles", "<p>Three large and a hundred small. Ruled by the Sea-Captains, who claim descent from a defeated noble house. They raid for tribute, occasionally trade, and have never accepted that the war ended.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A village has stopped paying its tribute and the next moon is just before the storms.</li><li>A wandering sword-saint has settled at the lighthouse and refuses to say why.</li><li>The Sea-Captains have a new heir, and she is making different kinds of decisions.</li></ul>"),
    ],
  },

  /* ============================================================
   *  Science Fiction (5)
   * ============================================================ */
  {
    slug: "neon-meridian",
    name: "Neon Meridian",
    description: "A vertical megacity where corp arcologies tower over rain-slick alleys and your augments are leased, never owned.",
    pages: [
      p("overview", "Overview", "<p>Meridian is a single vertical city, twelve kilometers tall, ringing the equator. The upper decks belong to the Big Six corps and the people who can afford their air. The middle decks are where most people live and most trouble happens. The lower decks are the dark and the wet, where the city eats itself slowly.</p><p>The Council of Six does not govern. It negotiates.</p>"),
      p("the-big-six", "The Big Six", "<p>Daimyo-Tessen Heavy. Aurelius Genomics. Triskelion Logistics. Hokkai Networks. Nakajima-Vance Energy. The Black Dahlia Group. Each has its own enclave, its own private security, and its own understanding of what \"law\" means inside its walls.</p>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Classic cyberpunk. Body modification, corporate vassalage, identity-as-a-service, neon and rain and bad coffee at three in the morning. Characters tend to be runners, fixers, ex-corporate, ex-military, or just trying to get out of debt.</p>"),
      p("hooks", "Common Hooks", "<ul><li>Your last extraction job ended badly and someone left a marker on your apartment door.</li><li>A new street drug is making people remember things that didn't happen to them.</li><li>The Council just announced an Audit. Nobody knows what an Audit is, or what it audits.</li></ul>"),
    ],
  },
  {
    slug: "the-belt",
    name: "The Belt",
    description: "Asteroid stations strung between Mars and Jupiter. Atmosphere is rented, rotation is rationed, and inner-system favors come due.",
    pages: [
      p("overview", "Overview", "<p>The Belt is the asteroid economy - thousands of stations, mining claims, and tucked-away habitats spread between Mars and Jupiter. The inner planets call it the frontier. The Belt calls itself a civilization the inner planets are too provincial to recognize.</p><p>The Coalition of Free Stations is real but loose. Inner-system corporations and navies arrive frequently. They never stay long.</p>"),
      p("life-on-station", "Life on Station", "<p>Spin-grav, recycled water, the constant low hum of life-support. Belt-born grow tall and lean. Inner-system visitors are obvious - and often condescending - within a day. Air, water, and rotation are the three currencies; everything else flows through them.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A long-thought-lost prospector ship has been spotted under thrust on a course it cannot have made on its own.</li><li>A Coalition station has gone dark for forty hours. The relief mission has not yet been authorized.</li><li>An inner-system fleet has anchored at the trailing-Jovian gate, claiming it is here for \"a routine inspection.\"</li></ul>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Hard sci-fi, working-class space - The Expanse-flavored. Politics, labor, water rights, the lethal indifference of vacuum. Characters tend to be crew, prospectors, agitators, or inner-system imports learning that the rules they brought don't apply.</p>"),
    ],
  },
  {
    slug: "salvage-empire",
    name: "Salvage Empire",
    description: "Generations after a war that ended civilization, fleets pick over the bones of the old high orbit and call it home.",
    pages: [
      p("overview", "Overview", "<p>The war ended four generations ago. Nobody now living was there. What remains is a broken ring of debris around the planet - hundreds of thousands of derelicts, dead stations, frozen corpses, and the occasional still-running ship that nobody in living memory has dared board.</p><p>The Salvage Houses pick this ring clean for a living. They are also slowly building, from the wreckage, a strange new civilization in orbit.</p>"),
      p("the-houses", "The Five Salvage Houses", "<p>House Iron, House Bell, House Mercer, House Whitehand, and House Below. Each has its own territory, its own ethics about what should and shouldn't be touched. House Below is the youngest and the most willing to crack open something the others wouldn't.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A House Bell scout has died of something that wasn't decompression.</li><li>One of the still-running ships has begun broadcasting again, in a language the linguists do not recognize.</li><li>House Below has invited the others to a parley. House Below has never invited anyone to anything.</li></ul>"),
    ],
  },
  {
    slug: "the-hollow-ark",
    name: "The Hollow Ark",
    description: "A generation ship two centuries off course. The crew remembers Earth as a story. Something else is awake in the lower decks.",
    pages: [
      p("overview", "Overview", "<p>The Ark left Earth two hundred and sixty years ago, bound for a system its mission planners promised would be habitable. Nobody on board has ever seen Earth. Nobody on board is sure where they are. The course logs were corrupted in the third generation; the archive was sealed by the fourth.</p><p>The current Captain is the eleventh to bear the title. She has been Captain for nine years and is increasingly uncertain whether the ship is still under way.</p>"),
      p("the-decks", "The Decks", "<p>Twelve decks officially. Thirteen unofficially - the lower deck has been sealed for sixty years, and the seal has begun, recently, to flex.</p>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Slow, quiet, claustrophobic sci-fi. Generation-ship melancholy. Mystery and dread. The discovery of how much has been forgotten - and the question of who arranged for the forgetting. Characters are crew or descendants; nobody is from anywhere else.</p>"),
    ],
  },
  {
    slug: "ortus-prime",
    name: "Ortus Prime",
    description: "A first-contact colony where humans and the native Ortusi share a rebuilt city - politely, tensely, with daily small disasters.",
    pages: [
      p("overview", "Overview", "<p>Ortus Prime is the first joint city. The Ortusi were already here when humans arrived; they had not, until then, encountered another sapient species and the experience has been, by all accounts, complicated.</p><p>The Joint Council governs - eleven Ortusi and eleven humans, plus a rotating arbiter. They argue about everything. They have built, against the odds, a city where both species can mostly live without killing each other.</p>"),
      p("the-ortusi", "The Ortusi", "<p>Tall, soft-spoken, deeply communal. Their language uses tone in ways human translators still botch. They find human individualism baffling, and human food alarming. They make excellent diplomats and terrible warriors - or so the humans like to think.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A human factory has begun emitting something the Ortusi consider sacrilegious.</li><li>A second human ship has arrived in orbit, unannounced.</li><li>An Ortusi has, for the first time on record, asked to live in the human quarter.</li></ul>"),
    ],
  },

  /* ============================================================
   *  Modern / Modern Fantasy (4)
   * ============================================================ */
  {
    slug: "ashford-bay",
    name: "Ashford Bay",
    description: "A small Pacific Northwest town where everyone knows everyone and the old families know more than they let on.",
    pages: [
      p("overview", "Overview", "<p>Ashford Bay is small - twelve thousand people, an old marina, three churches, one tavern that's seen four generations of the same family run it. Tourists come for the lighthouse. Locals come for everything else.</p><p>It looks ordinary. It is mostly ordinary. The exceptions are the kind nobody talks about over breakfast at the diner.</p>"),
      p("the-old-families", "The Old Families", "<p>The Holcombs, the Wrens, the Marletts, the Blackthorns. They've been here since the town was founded. They mostly get along. They mostly know what each other does. There are very few new people on the town council and very few accidents that go uninvestigated.</p>"),
      p("hooks", "Common Hooks", "<ul><li>You moved here for the cheap rent and the quiet. Your landlord is a Wren and asked, very politely, that you not go down to the marina after dark.</li><li>A body has washed up that is missing both shoes and an entire decade.</li><li>The lighthouse keeper has resigned. The Council is holding interviews.</li></ul>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Slow-burn modern with quiet supernatural. Small-town politics, secrets, old family ties. Suitable for slice-of-life with edges, supernatural mystery, and the slow discovery that the place you moved to is older than its zoning records.</p>"),
    ],
  },
  {
    slug: "veiled-city",
    name: "The Veiled City",
    description: "Modern New York with the Veil drawn back: alchemists in Brooklyn, a vampire court in Midtown, and a tense detente nobody discusses.",
    pages: [
      p("overview", "Overview", "<p>The Veiled City is the present day, the city you know - and a layer beneath it that runs in parallel, shielded from mortal sight by the Veil. Alchemists, witches, vampires, fae enclaves, ghoul-haunts, ancient orders, all going about their business in the same coffee shops as everyone else.</p><p>The Concordat keeps the peace. Mostly.</p>"),
      p("the-houses-and-orders", "Houses, Orders, &amp; Cabals", "<p>The Crimson Court (vampires, midtown). The Verdant Concord (witches and druids, with strongholds in Prospect Park). The Order of the Open Door (mortal allies; lawyers, mostly). The Fae enclave under the High Line. A dozen smaller groups, plus the lone wolves who answer to no one.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A mortal saw something they shouldn't have, and is now hiding in your apartment.</li><li>A Concordat envoy has been killed by something that left no aura.</li><li>The Open Door has filed paperwork. Nobody knows yet what for.</li></ul>"),
    ],
  },
  {
    slug: "academy-st-vincents",
    name: "St. Vincent's Academy",
    description: "A modern boarding school for gifted students. The brochure does not mention that some of the gifts are unusual.",
    pages: [
      p("overview", "Overview", "<p>St. Vincent's Academy is an exclusive coeducational boarding school in upstate New York. The brochure mentions equestrian facilities, AP classes, and a notable choir.</p><p>It does not mention the locked east wing, the optional after-hours seminar in \"Comparative Symbology,\" or the fact that admission decisions are made not by the headmaster but by an older woman who is never officially on campus.</p>"),
      p("the-faculty", "The Faculty", "<p>Most are normal. Some are extremely not normal. The Latin teacher is older than the building. The athletics coach has won the regional championship six years running and has never been seen to sweat.</p>"),
      p("hooks", "Common Hooks", "<ul><li>You received a letter of admission you did not apply for.</li><li>A student vanished from the dorms last term. The official story is they transferred. The dorm is missing the entire room they were in.</li><li>The Headmaster has scheduled a special assembly. Special assemblies have not historically gone well.</li></ul>"),
    ],
  },
  {
    slug: "hollow-rivers",
    name: "Hollow Rivers",
    description: "A mid-American river town where the floods come back wrong and the family that owns the levee owns more than that.",
    pages: [
      p("overview", "Overview", "<p>Hollow Rivers, population sixteen thousand, sits at a bend of a slow river that is older than any of the names on the map. The town was founded by the Calhoun family, who still own the largest house, the largest tract of land, and the levee.</p><p>Most people leave Hollow Rivers and never come back. The ones who do come back are not always quite the same.</p>"),
      p("the-river", "The River", "<p>It floods every seven years. Has done so on schedule for as long as anyone has kept records. The Calhoun levee always holds. The things the river leaves behind, when it recedes, are not always natural.</p>"),
      p("hooks", "Common Hooks", "<ul><li>You inherited a house here from a relative you did not know you had.</li><li>The seventh-year flood is six weeks out and the river is already rising.</li><li>A Calhoun has been seen in town for the first time in a decade, and is asking after specific people.</li></ul>"),
    ],
  },

  /* ============================================================
   *  Horror / Gothic (2)
   * ============================================================ */
  {
    slug: "blackmire",
    name: "Blackmire",
    description: "A drowned village beneath a reservoir. The waterline is rising. Things long buried are nearly back at the surface.",
    pages: [
      p("overview", "Overview", "<p>Blackmire was a fishing village. Eighty years ago the dam was built and the valley was flooded. The villagers were relocated, mostly. The reservoir has been peaceful, mostly. Until this summer.</p><p>The water level is dropping. Roofs are showing through. The locals at the edge of the new lake have started having the same dreams.</p>"),
      p("what-was-buried", "What Was Buried", "<p>The official record says the cemetery was relocated. The official record is incomplete. The church, the workhouse, and the old well all remained.</p>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Folk horror, slow dread, the past surfacing through the present. Suitable for investigators, journalists, returning descendants, and the sort of person who reads regional newspapers.</p>"),
    ],
  },
  {
    slug: "ravensreach",
    name: "Ravensreach Manor",
    description: "A gothic estate of long halls, longer halls, and a family that does not introduce its inheritance to outsiders.",
    pages: [
      p("overview", "Overview", "<p>Ravensreach Manor sits on a moor of its own, several days from anything. The Ravenshaw family has lived there for nine centuries. The current Lord Ravenshaw is the youngest in three generations - he is forty-one - and he has been advertising for staff.</p><p>The previous staff did not leave. They simply, over the past eighteen months, declined to be present.</p>"),
      p("hooks", "Common Hooks", "<ul><li>You answered the advertisement. Tutor, valet, gamekeeper, secretary - the salary is generous and the position is residential.</li><li>You are a cousin and have been summoned.</li><li>You are an investigator and the previous valet's family has hired you.</li></ul>"),
    ],
  },

  /* ============================================================
   *  Western / Frontier (2)
   * ============================================================ */
  {
    slug: "dust-and-rail",
    name: "Dust &amp; Rail",
    description: "A late-1800s western frontier of railroad towns, cattle barons, marshals, and ghosts that arrive on the noon train.",
    pages: [
      p("overview", "Overview", "<p>The territory is being settled in pieces. The railroad came in last summer; the towns came in around it. The Cattle Concern owns half the open range. The Marshals enforce, where they can be persuaded to ride out, what little law has been written.</p><p>It is hot. It is dry. It is full of opportunity, and of the particular kind of trouble opportunity attracts.</p>"),
      p("the-towns", "The Towns", "<p><b>Whistle Halt</b> - the railhead, three saloons, one hotel, growing fast.</p><p><b>Sweetwater</b> - older, ranching country, Cattle Concern stronghold.</p><p><b>Mercy</b> - mining town, mostly tents, one church, one undertaker.</p>"),
      p("hooks", "Common Hooks", "<ul><li>You're a marshal sent to investigate why three Cattle Concern hands turned up dead near Sweetwater.</li><li>You're a card-sharp running a long con on a railroad executive.</li><li>You stepped off the noon train and the man who was supposed to meet you is not at the station.</li></ul>"),
    ],
  },
  {
    slug: "weird-frontier",
    name: "The Weird Frontier",
    description: "Same dust, same rail, same towns. But the natives know what's in the canyons, and the snake-oil sometimes works.",
    pages: [
      p("overview", "Overview", "<p>The frontier as you know it - and a layer beneath. The native peoples have always known about the canyon-things, the rock-spirits, the reasons certain valleys are not crossed at night. The settlers are slowly, painfully, learning.</p><p>Some of them learn from the natives. Some learn from each other. Some learn the hard way.</p>"),
      p("the-knowing-trades", "The Knowing Trades", "<p>Hexbreakers. Soothsayers. Snake-oil men whose snake-oil sometimes really does work. Preachers with a particular gift for keeping certain things at bay. They circulate through the towns under various pretexts; the wise sheriff knows who they are and pretends not to.</p>"),
      p("tone-and-themes", "Tone &amp; Themes", "<p>Weird Western. Folk-magic, indigenous traditions, frontier occult. The land is older than the maps; the maps are wrong; the people who know better keep quiet. Suitable for gunslingers, hexbreakers, doomed gamblers, and anyone with unfinished business.</p>"),
    ],
  },

  /* ============================================================
   *  Steampunk / Victorian (2)
   * ============================================================ */
  {
    slug: "albion-aether",
    name: "Albion Aether",
    description: "A Victorian-flavored capital of brass airships, aether-fueled mechanisms, and a Crown that quietly licenses every mage on the isles.",
    pages: [
      p("overview", "Overview", "<p>Albion is at the height of its Aether Era - dirigibles drift over the city, brass mechanisms power the trams, and the Royal Office of Arcane Affairs licenses every practitioner on the isles. The Empire stretches; the rivals chafe; the salons gossip.</p>"),
      p("the-royal-office", "The Royal Office", "<p>Every mage of any consequence is registered, taxed, and occasionally invited to dinner. The Office maintains the appearance of total control. In practice, the unlicensed and the foreign and the eccentric all do their work in the city's quieter corners, and the Office prefers it that way.</p>"),
      p("hooks", "Common Hooks", "<ul><li>Your engineering firm has been awarded a contract by the Office. The specifications are oddly redacted.</li><li>An aether-merchant has been killed in a manner the constabulary refuses to describe.</li><li>A foreign delegation has arrived with a gift the Crown does not know how to refuse or accept.</li></ul>"),
    ],
  },
  {
    slug: "the-clockwork-republic",
    name: "The Clockwork Republic",
    description: "A young democracy of automaton labor, suffrage debates, and a disquieting question: do the machines dream?",
    pages: [
      p("overview", "Overview", "<p>The Republic is forty years old. It threw off its empire and built itself on factory machinery and clockwork labor. The factories are vast; the workers are fewer than they once were; the automata are everywhere.</p><p>The latest model can hold a conversation. The newest debate in the Senate is whether they should be allowed to vote.</p>"),
      p("the-factions", "The Factions", "<p><b>The Reformers</b> - want to extend rights, slowly, with study.</p><p><b>The Naturalists</b> - want to roll the program back; humans first.</p><p><b>The Free Mechanicals</b> - automata, mostly, who have organized themselves and are no longer asking permission.</p>"),
      p("hooks", "Common Hooks", "<ul><li>An automaton has died in suspicious circumstances at a Reformer's home.</li><li>A factory in the south has gone silent and the foreman cannot be reached.</li><li>The Free Mechanicals have called a general strike.</li></ul>"),
    ],
  },

  /* ============================================================
   *  Mythological / Folk (2)
   * ============================================================ */
  {
    slug: "the-low-roads",
    name: "The Low Roads",
    description: "A folkloric Britain of crossroads, hawthorn pacts, hollow hills, and traveling people who know which doors to knock on.",
    pages: [
      p("overview", "Overview", "<p>The Low Roads are the older roads - not on the modern maps, not paved, not always quite in the same place from one trip to the next. The traveling people know them. The crossroads-witches know them. The hollow-hill folk certainly know them.</p><p>The world above is the modern day. The world below is older than that.</p>"),
      p("the-pacts", "The Pacts", "<p>Hawthorn pacts. Iron pacts. Salt pacts. Bread-and-honey pacts. The old courtesies that, observed correctly, let travelers move between the layers without losing themselves.</p>"),
      p("hooks", "Common Hooks", "<ul><li>You inherited a house at a crossroads, and the milk on the doorstep keeps disappearing.</li><li>A child has gone missing on a Low Road, and only the traveling people know exactly where.</li><li>A pact is being broken somewhere, and the consequences are arriving in a town that was once safely above all of it.</li></ul>"),
    ],
  },
  {
    slug: "the-thousand-shores",
    name: "The Thousand Shores",
    description: "An ocean-civilization of island-cities, navigator-priests, and gods who answer when their names are sung in the right key.",
    pages: [
      p("overview", "Overview", "<p>The Thousand Shores is an archipelago empire spread across an ocean so vast no ship has ever crossed its center. The navigator-priests of the Shore Houses are the only people who can read the deep currents; without them no ship goes far.</p><p>The gods are present. Not metaphorically. Not subtly. They answer when sung to in the right key.</p>"),
      p("the-shore-houses", "The Shore Houses", "<p>Five great ones, dozens of lesser. They keep the sea-charts, train the navigator-priests, and quietly run most of the politics. The Thrones of the Houses are ancestral, and never empty for long.</p>"),
      p("hooks", "Common Hooks", "<ul><li>A navigator has gone deep and not returned, and her House is hiring.</li><li>A god's song has drifted out of tune; the tides are answering wrongly.</li><li>An island that does not exist on any chart has appeared on the eastern horizon.</li></ul>"),
    ],
  },
];
