"""Local long-document dataset setup; called by evals.run_retrieval --dataset long."""

import hashlib
import json
import shutil
from pathlib import Path

from evals.progress import Progress
from evals.run_pdf_retrieval import main

HERE = Path(__file__).parent / "long_retrieval"


async def run(chunk_tokens=None, prepare_pdf=None, dry_run=False, *, verbose=False):
    progress = Progress(verbose)
    progress.log("Load long-document dataset manifest")
    spec = json.loads((HERE / "dataset.json").read_text(encoding="utf-8"))
    pdf = HERE / "pdfs" / spec["filename"]
    if prepare_pdf:
        if hashlib.sha256(prepare_pdf.read_bytes()).hexdigest() != spec["sha256"]:
            raise ValueError(
                "This dataset is labelled for 125976903.pdf; the supplied PDF has a different checksum"
            )
        pdf.parent.mkdir(parents=True, exist_ok=True)
        if prepare_pdf.resolve() != pdf.resolve():
            shutil.copyfile(prepare_pdf, pdf)
    if not pdf.exists():
        raise FileNotFoundError(
            "Prepare the local PDF first: python -m evals.run_retrieval --dataset long "
            '--prepare-pdf "path/to/125976903.pdf" --dry-run'
        )
    if hashlib.sha256(pdf.read_bytes()).hexdigest() != spec["sha256"]:
        raise ValueError("Local dataset PDF changed; checksum verification failed")
    progress.log("PDF checksum verified")
    sizes = (chunk_tokens,) if chunk_tokens else tuple(spec["chunk_sizes"])
    # Store separate reports for individual sizes and for the comparison.
    output = HERE / "results" / (str(chunk_tokens) if chunk_tokens else "comparison")
    await main(
        pdf,
        output,
        dry_run,
        labels_path=HERE / spec["labels"],
        sizes=sizes,
        min_chunks=spec["min_chunks_per_configuration"],
        verbose=verbose,
    )
