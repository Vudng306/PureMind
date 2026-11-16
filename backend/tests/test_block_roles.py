"""Clean Reader rules on blocks laid out by hand: cases met in papers outside the benchmark (Frontiers)."""

from dataclasses import dataclass

from app.services.block_roles import classify, supplementary


@dataclass
class B:
    text: str
    x: float = 300
    size: float = 10
    kind: str = "text"
    role: str | None = None
    confidence: float = 0
    reason: str = ""

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.x, 100, self.x + 200, 112)


def test_heading_names_read_through_ligatures():
    assert supplementary("Conﬂict of interest") == "CONFLICT_OF_INTEREST"
    assert supplementary("Publisher’s note") == "DECLARATION"
    assert supplementary("Ethics statement") == "DECLARATION"
    assert supplementary("Ethics") is None  # a section of an essay on ethics, not a statement


def test_references_go_on_after_parts_set_beside_them():
    # Two columns: half the list, then the right column's notes, then the rest of the list without a heading.
    body = [B(f"Body paragraph {n} of the article, long enough to be read as such.") for n in range(12)]
    end = [
        B("## References"),
        B("Abbas, A., and Thielsch, M. T. (2022). An arabic version of the inventory."),
        B("## Author contributions"),
        B("DU and FB implemented the online study."),
        B("## Conﬂict of interest"),
        B("The authors declare no competing interests."),
        B("## Publisher’s note"),
        B("All claims expressed in this article are solely those of the authors."),
        B("gov.au/system/files/report.pdf (accessed September 9, 2022)."),
        B("Ater, T. (2017). Building Progressive Web Apps. Newton, MA: O’Reilly Media."),
        B("Zhu, D. H., and Chang, Y. P. (2020). Understanding the influence of devices."),
    ]
    classify([body + end], [800], 10)
    assert all(b.role is None for b in body)
    assert [b.role for b in end] == [
        "REFERENCES", "REFERENCES",
        "AUTHOR_CONTRIBUTIONS", "AUTHOR_CONTRIBUTIONS",
        "CONFLICT_OF_INTEREST", "CONFLICT_OF_INTEREST",
        "DECLARATION", "DECLARATION",
        "REFERENCES", "REFERENCES", "REFERENCES",
    ]  # fmt: skip


def test_journal_sidebar_is_not_the_authors():
    page = [
        B("OPEN ACCESS", x=40, size=8),
        B("EDITED BY", x=40, size=8),
        B("Carlos Duarte, University of Lisbon, Portugal", x=40, size=8),
        B("REVIEWED BY", x=40, size=8),
        B("# Smartphone app aesthetics influence users’ experience", size=20),
        B("### Sebastian A. C. Perrig*†, David Ueffing† and Florian Brühlmann", size=12),
        B("Wayne Giang, University of Florida, United States", x=40, size=8),
        B("CITATION", x=40, size=8),
        B(
            "Perrig SAC and Brühlmann F (2023) Smartphone app aesthetics. Front. Psychol. 14:1113842.",
            x=40,
            size=8,
        ),
        B("Abstract: Aesthetics are a core part of how people judge apps, and this study tests it."),
        B("KEYWORDS", x=40, size=8),
        B("aesthetics, performance, usability, smartphones", x=40),
        B("## 1. Introduction"),
        B("Body of the introduction, long enough to be read as such."),
    ]
    title = classify([page], [800], 10)
    roles = {b.text[:14]: b.role for b in page}
    assert title and title.startswith("Smartphone")
    assert roles["OPEN ACCESS"] == roles["EDITED BY"] == roles["REVIEWED BY"] == "PUBLISHER_INFO"
    assert roles["Carlos Duarte,"] == roles["Wayne Giang, U"] == "PUBLISHER_INFO"  # the journal's editors
    assert roles["### Sebastian "] == "AUTHORS"  # between them in reading order, but in the other column
    assert roles["Perrig SAC and"] == "PUBLISHER_INFO"
    assert roles["KEYWORDS"] == roles["aesthetics, pe"] == "KEYWORDS"
    assert roles["Abstract: Aest"] is None and roles["Body of the in"] is None
