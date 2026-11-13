"""Collections: the shelves of a user's library. A document is on one shelf at most."""

import uuid

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep
from app.core.messages import MSG
from app.models import MAX_COLLECTION_NAME, Collection, Document, User

router = APIRouter(prefix="/collections", tags=["collections"])


class CollectionIn(BaseModel):
    name: str = Field(max_length=MAX_COLLECTION_NAME)


class CollectionOut(BaseModel):
    id: uuid.UUID
    name: str
    document_count: int


async def owned_collection(session: AsyncSession, user: User, collection_id: uuid.UUID) -> Collection:
    collection = await session.get(Collection, collection_id)
    if collection is None or collection.user_id != user.id:  # NFR-SEC-04
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-COLLECTION-404"])
    return collection


def _clean(name: str) -> str:
    name = " ".join(name.split())
    if not name:
        raise HTTPException(422, MSG["MSG-COLLECTION-NAME"])
    return name


async def _count(session: AsyncSession, collection_id: uuid.UUID) -> int:
    return (
        await session.scalar(select(func.count(Document.id)).where(Document.collection_id == collection_id))
        or 0
    )


async def _commit(session: AsyncSession) -> None:
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-COLLECTION-DUP"]) from None


@router.get("", response_model=list[CollectionOut])
async def list_collections(user: CurrentUser, session: SessionDep):
    rows = await session.execute(
        select(Collection.id, Collection.name, func.count(Document.id).label("document_count"))
        .outerjoin(Document, Document.collection_id == Collection.id)
        .where(Collection.user_id == user.id)
        .group_by(Collection.id)
        .order_by(Collection.name)
    )
    return [CollectionOut.model_validate(r, from_attributes=True) for r in rows.all()]


@router.post("", response_model=CollectionOut, status_code=status.HTTP_201_CREATED)
async def create_collection(payload: CollectionIn, user: CurrentUser, session: SessionDep):
    collection = Collection(user_id=user.id, name=_clean(payload.name))
    session.add(collection)
    await _commit(session)
    return CollectionOut(id=collection.id, name=collection.name, document_count=0)


@router.patch("/{collection_id}", response_model=CollectionOut)
async def rename_collection(
    collection_id: uuid.UUID, payload: CollectionIn, user: CurrentUser, session: SessionDep
):
    collection = await owned_collection(session, user, collection_id)
    collection.name = _clean(payload.name)
    await _commit(session)
    return CollectionOut(
        id=collection.id, name=collection.name, document_count=await _count(session, collection.id)
    )


@router.delete("/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_collection(collection_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """The documents stay in the library, off any shelf."""
    collection = await owned_collection(session, user, collection_id)
    await session.delete(collection)
    await session.commit()
