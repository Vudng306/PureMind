"""Choose the feed's short articles that also belong on /explore, and write them for the catalog.

    python -m app.scripts.pick_explore            # write data/catalog-picks.json
    python -m app.scripts.pick_explore --dry-run  # only list what would be chosen

The catalog's own articles are long research papers. These are the three-to-ten-minute reads beside them. They
are copied, but an article hidden or deleted in the admin page leaves /explore at once (routes/catalog); a new
run only fills its place. A choice has to:
- be open to anyone to read as written: every licence here allows that, and CC BY-ND forbids only changing it,
  so these are never given a Quick Read;
- say in its title that it is about one of Explore's topics, in a feed topic that agrees, as a word in a long
  text proved no guide to what an article is about (see collect_catalog);
- last: no news of the day, no politicians or wars, nothing written for children;
- leave room for other sources beside The Conversation, which is most of the feed.
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.db.session import SessionLocal, engine
from app.models import Article
from app.services.articles import source_names

OUTPUT = Path(__file__).resolve().parents[1] / "data" / "catalog-picks.json"
PER_TOPIC = 12
MAX_FROM_ONE_SOURCE = 8  # of a topic's articles, when other sources have enough
MIN_WORDS, MAX_WORDS = 660, 2200  # three to ten minutes
SOURCES = (
    "conversation",
    "globalvoices",
    "elife",
    "owid",
)  # frym writes for children, the rest for scientists


def _terms(*terms: str) -> re.Pattern:
    return re.compile(rf"\b({'|'.join(terms)})\b", re.I)


# Explore's topic: the feed topics that may hold it, and what its title has to speak of.
TOPICS: dict[str, tuple[set[str], re.Pattern]] = {
    "Di cư và hòa nhập": (
        {"society", "culture", "economy", "law", "mind", "family", "health", "history"},
        _terms(
            # Not a bare "migration" or "asylum": birds migrate, and there was a song about an asylum.
            r"migrants?",
            r"immigrants?",
            r"immigration",
            r"emigration",
            r"refugees?",
            r"asylum seekers?",
            r"diasporas?",
            r"expats?",
            r"newcomers?",
            r"leaving home",
            r"homesick\w*",
            r"displaced",
        ),
    ),
    "Đô thị và cộng đồng": (
        {"society", "environment", "culture", "economy", "health"},
        _terms(
            r"cit(y|ies)",
            r"urban",
            r"neighbou?rs?",
            r"neighbou?rhoods?",
            r"suburbs?",
            r"housing",
            r"homeless\w*",
            r"renters?",
            r"public transport",
            r"walkable",
            r"dog parks?",
            r"public spaces?",
            r"local communit(y|ies)",
            r"street trees?",
        ),
    ),
    "Mạng xã hội và công nghệ": (
        {"technology", "society", "mind", "culture"},
        _terms(
            r"social media",
            r"tiktok",
            r"instagram",
            r"facebook",
            r"youtube",
            r"smartphones?",
            r"phones?",
            r"screens?",
            r"chatbots?",
            r"chatgpt",
            r"algorithms?",
            r"influencers?",
            r"online",
            r"deepfakes?",
            r"ai",
            r"artificial intelligence",
        ),
    ),
    "Gia đình và nuôi dạy con": (
        {"family", "mind", "society", "education"},
        _terms(
            r"parents?",
            r"parenting",
            r"mothers?",
            r"fathers?",
            r"mums?",
            r"moms?",
            r"dads?",
            r"motherhood",
            r"fatherhood",
            r"grandparents?",
            r"bab(y|ies)",
            r"toddlers?",
            r"teen(ager)?s?",
            r"siblings?",
            r"famil(y|ies)",
            r"childhood",
            r"kids?",
            r"children",
        ),
    ),
    "Giáo dục": (
        {"education"},
        _terms(
            r"schools?",
            r"teachers?",
            r"students?",
            r"classrooms?",
            r"universit(y|ies)",
            r"colleges?",
            r"pre-?k",
            r"preschool",
            r"homework",
            r"learning",
            r"curriculum",
        ),
    ),
    "Công việc và kinh tế": (
        {"economy"},
        _terms(
            r"jobs?",
            r"workers?",
            r"workplaces?",
            r"work",
            r"working",
            r"employees?",
            r"employers?",
            r"bosses",
            r"managers?",
            r"careers?",
            r"wages?",
            r"salar(y|ies)",
            r"gig",
            r"burnout",
            r"retire\w*",
            r"inventors?",
            r"four-day",
            r"unemployment",
            r"pay gaps?",
            r"job seekers?",
        ),
    ),
    "Tâm lý và các mối quan hệ": (
        {"mind", "family", "society"},
        _terms(
            r"lonel\w+",
            r"friends?",
            r"friendships?",
            r"relationships?",
            r"love",
            r"dating",
            r"marriages?",
            r"couples?",
            r"partners?",
            r"attachment",
            r"emotions?",
            r"empathy",
            r"grief",
            r"kindness",
            r"happiness",
            r"empty nest",
            r"romantic",
            r"intimacy",
            r"forgiv\w+",
            r"regret",
            r"memor(y|ies)",
            r"boredom",
        ),
    ),
    "Sức khỏe cộng đồng": (
        {"health"},
        _terms(
            r"public health",
            r"vaccin\w+",
            r"mental health",
            r"health ?care",
            r"pandemics?",
            r"malaria",
            r"obesity",
            r"smoking",
            r"vaping",
            r"alcohol",
            r"air pollution",
            r"life expectancy",
            r"sleep",
            r"body clock",
            r"exercise",
            r"ageing",
            r"aging",
            r"health inequal\w+",
            r"long covid",
        ),
    ),
    "Môi trường": (
        {"environment"},
        _terms(
            r"climate",
            r"plastics?",
            r"forests?",
            r"deforestation",
            r"biodiversity",
            r"wildlife",
            r"oceans?",
            r"coral",
            r"pollution",
            r"recycling",
            r"species",
            r"extinction",
            r"carbon",
            r"heatwaves?",
            r"wildfires?",
            r"rivers?",
            r"insects?",
            r"bees?",
            r"floods?",
            r"flooding",
            r"hurricanes?",
            r"storms?",
            r"drought",
            r"nature",
            r"birds?",
            r"bird-safe",
            r"mosquitoes",
            r"planet",
            r"warming",
            r"trees?",
            r"whales?",
            r"fish",
            r"soil",
            r"ecosystems?",
            r"animals?",
            r"emissions",
            r"solar",
            r"green roofs?",
            r"yard care",
        ),
    ),
}

LEAVING_HOME = "Di cư và hòa nhập"

# What dates fast or is about power rather than people's lives. Searched in the title and the summary.
NEWS = _terms(
    r"trump\w*",
    r"biden",
    r"harris",
    r"starmer",
    r"albanese",
    r"carney",
    r"reeves",
    r"farage",
    r"poilievre",
    r"one nation",
    r"modi",
    r"putin",
    r"netanyahu",
    r"xi jinping",
    r"musk",
    r"mamdani",
    r"vance",
    r"election\w*",
    r"parliament\w*",
    r"senate",
    r"congress\w*",
    r"white house",
    r"budgets?",
    r"tariffs?",
    r"prime minister",
    r"supreme court",
    r"ukrain\w+",
    r"gaza",
    r"israel\w*",
    r"palestin\w+",
    r"iran\w*",
    r"russia\w*",
    r"democrats?",
    r"republicans?",
    r"labour party",
    r"voters?",
    r"lawsuit",
)
# The same, and places a reader elsewhere has no stake in, which only a title gives away: a summary may mention
# a government or a country in passing. Global Voices reports from one country a piece, so it keeps its countries.
LOCAL_TITLE = _terms(
    r"polic(y|ies)\w*",
    r"policymakers?",
    r"government\w*",
    r"federal",
    r"bills?",
    r"legislation",
    r"court\w*",
    r"scandal",
    r"state takeovers?",
    r"department of \w+",
    r"regulated?",
    r"laws?",
    r"australian?s?",
    r"new zealand",
    r"nz",
    r"aotearoa",
    r"aboriginal",
    r"u\.s\.",
    r"america\w*",
    r"canad\w+",
    r"british",
    r"britain",
    r"uk",
    r"england",
    r"scotland",
    r"wales",
    r"ireland",
    r"florida",
    r"texas",
    r"michigan",
    r"california\w*",
    r"philadelphia",
    r"pennsylvania\w*",
    r"oklahoma",
    r"detroit",
    r"south africa\w*",
    r"nigeria\w*",
    r"kenya\w*",
    r"ghana\w*",
    r"african?",
)
THE_US = re.compile(r"\bUS\b")  # in capitals, or it is "us"
# Halloween will not last, and a piece on an assault or a killing does not belong among things to explore.
UNFIT_TITLE = _terms(
    r"editorial",
    r"erratum",
    r"correction",
    r"quiz",
    r"halloween",
    r"christmas",
    r"rape",
    r"sexual",
    r"assault\w*",
    r"violence",
    r"abuse",
    r"suicid\w+",
    r"killed",
    r"murder\w*",
    r"trafficking",
    r"gang\S*",
)
# Read and turned down by hand, by a part of their address: their words fit, what they are about does not.
TURNED_DOWN = (
    # Education
    "thai-student-movement",
    "why-faculty-diversity",
    "fraternity",
    "religious-charter",
    "faculty-and-students-show",
    # Leaving home
    "the-government-might-strip",
    "canadas-immigration-system",
    "unpacking-floridas",
    "grattan-on-friday",
    # Health
    "how-wellness-clinics",
    "autistic-children-come",
    "a-dengue-vaccine",
    "mental-health-of-politicians",
    "can-creatine",
    "restraint-can-leave",
    "frances-student-uprising",
    # Environment
    "how-hurricane-isaias",
    "we-blasted-mobile-homes",
    "penguin",
    "flood-zone",
    # Cities
    "four-ways-cities",
    "abujas-housing",
    "nairobi",
    "detroit",
    # Family
    "parents-let-your-kids",
    "sex-after-baby",
    "boo-how-to-pick",
    "lazy-weak-bewitched",
    # Work
    "we-studied-1-584",
    "courts-and-unions",
    "across-latin-america-may-day",
    "treasury",
    # Technology
    "anthropic-exposes",
    "when-chatbots-become",
    "why-calling-for-a-kill-switch",
    "a-crackdown-on-online",
    "when-radio-finds",
    "how-journalism-inspired",
    "subsea",
    "violent-porn",
    "barcelona-unrest",
    "warning-signals-venezuela",
    # Relationships
    "year-12-students",
    "a-cree-psychotherapist",
    "/111806",
    "an-invisible-ai-watermark",
    "daejon-love",
)
# Our World in Data's sign-up box, which came along with the page. It is the site's, not the article's.
SITE_PROMO = re.compile(r"We send two regular newsletters[^\n]*\n*")


def fits(topic: str, title: str, feed_topics: set[str]) -> bool:
    """Whether a title speaks of an Explore topic, in a feed topic that may hold it."""
    wanted, terms = TOPICS[topic]
    return bool(feed_topics & wanted and terms.search(title))


def eligible(a: Article) -> bool:
    return (
        a.hidden_at is None
        and a.based_on_id is None
        and a.source in SOURCES
        and MIN_WORDS <= a.word_count <= MAX_WORDS
        and not UNFIT_TITLE.search(a.title)
        and not NEWS.search(f"{a.title} {a.summary}")
        and (
            a.source == "globalvoices"
            or TOPICS[LEAVING_HOME][1].search(a.title)  # a story of moving names the place by nature
            or not (LOCAL_TITLE.search(a.title) or THE_US.search(a.title))
        )
        and not any(part in a.url for part in TURNED_DOWN)
    )


def choose(articles: list[Article], per_topic: int = PER_TOPIC) -> dict[str, list[Article]]:
    """For each topic its newest fitting articles, none twice. The scarcest topics pick first, as an article can
    fit several and the plentiful ones can spare it."""
    candidates = {
        topic: [a for a in articles if fits(topic, a.title, {t.topic for t in a.topics})] for topic in TOPICS
    }
    used: set = set()
    chosen: dict[str, list[Article]] = {}
    for topic in sorted(TOPICS, key=lambda name: len(candidates[name])):
        free = sorted((a for a in candidates[topic] if a.id not in used), key=_newest, reverse=True)
        others = [a for a in free if a.source != "conversation"][
            : per_topic - min(MAX_FROM_ONE_SOURCE, per_topic)
        ]
        # The Conversation fills what the other sources leave.
        picked = others + [a for a in free if a.source == "conversation"][: per_topic - len(others)]
        chosen[topic] = sorted(picked, key=_newest, reverse=True)
        used.update(a.id for a in picked)
    return chosen


def _newest(a: Article) -> str:
    return a.published_at.isoformat() if a.published_at else ""


def entry(topic: str, a: Article, names: dict[str, str]) -> dict:
    """An article as the catalog keeps it."""
    return {
        "id": a.id.hex,
        "url": a.url,
        "title": a.title,
        "topic": topic,
        "kind": a.kind,
        "language": a.language,
        "source": names.get(a.source, a.source),
        "authors": a.credit,
        "published_at": a.published_at.date().isoformat() if a.published_at else "",
        "doi": a.doi or "",
        "content": SITE_PROMO.sub("", a.content),
        "description": a.summary,
        "license": a.license,
        "license_url": a.license_url,
        "attribution_url": a.url,
        "content_note": "",
    }


async def run(dry_run: bool) -> None:
    async with SessionLocal() as session:
        rows = await session.scalars(select(Article).options(undefer(Article.content)))
        chosen = choose([a for a in rows if eligible(a)])
    await engine.dispose()
    names = source_names()
    picks = []
    for topic, articles in chosen.items():
        print(f"\n{topic}: {len(articles)}")
        for a in articles:
            print(f"  {a.word_count:5d} {a.source[:6]:6} {_newest(a)[:10]} {a.title}")
            picks.append(entry(topic, a, names))
    print(f"\n{len(picks)} articles")
    if not dry_run:
        OUTPUT.write_text(json.dumps(picks, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"written to {OUTPUT.name}")


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Choose the feed's short articles for /explore.")
    parser.add_argument("--dry-run", action="store_true", help="only list what would be chosen")
    args = parser.parse_args(argv)
    asyncio.run(run(args.dry_run))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1:])
