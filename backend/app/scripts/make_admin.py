"""Grant or revoke the admin role (FR-ADM-01).

    python -m app.scripts.make_admin someone@example.com
    python -m app.scripts.make_admin someone@example.com --revoke

The account must have signed in to PureMind once, which is when its profile row is created. The role is
given here rather than from the admin page so that no web request can ever make an admin.
"""

import argparse
import asyncio
import sys

from sqlalchemy import func, select

from app.db.session import SessionLocal, engine
from app.models import User


async def set_role(email: str, admin: bool) -> str:
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
        if user is None:
            raise SystemExit(
                f"No PureMind account for {email}: sign in to the app once, then run this again."
            )
        user.role = "admin" if admin else "user"
        await session.commit()
        return f"{user.email} is now {'an admin' if admin else 'a regular user'}."


async def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Grant or revoke the PureMind admin role.")
    parser.add_argument("email")
    parser.add_argument("--revoke", action="store_true", help="make the account a regular user again")
    args = parser.parse_args(argv)
    try:
        print(await set_role(args.email, not args.revoke))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
