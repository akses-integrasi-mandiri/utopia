use crate::{
    auth::AuthUser,
    error::ApiResult,
    research::{self, Coverage, ResearchJob},
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use utopia_core::{models::Role, AppError};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct CoverageBody {
    query: String,
    conversation_id: Option<Uuid>,
}
#[derive(Deserialize)]
pub struct CreateBody {
    query: String,
    conversation_id: Option<Uuid>,
    approved: bool,
    request_id: Uuid,
}
#[derive(Deserialize)]
pub struct ListParams {
    conversation_id: Option<Uuid>,
}

async fn check_conversation(
    state: &AppState,
    kb_id: Uuid,
    user_id: Uuid,
    conversation_id: Option<Uuid>,
) -> ApiResult<()> {
    if let Some(id) = conversation_id {
        utopia_store::conversations::require_owned(&state.pool, kb_id, user_id, id).await?;
    }
    Ok(())
}

pub async fn coverage(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(kb_id): Path<Uuid>,
    Json(body): Json<CoverageBody>,
) -> ApiResult<Json<Coverage>> {
    let kb = utopia_store::access::require_kb(&state.pool, &user, kb_id, Role::Viewer).await?;
    check_conversation(&state, kb_id, user.id, body.conversation_id).await?;
    Ok(Json(
        research::coverage(&state, kb_id, kb.workspace_id, &body.query).await?,
    ))
}

pub async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(kb_id): Path<Uuid>,
    Json(body): Json<CreateBody>,
) -> ApiResult<Json<ResearchJob>> {
    utopia_store::access::require_kb(&state.pool, &user, kb_id, Role::Editor).await?;
    check_conversation(&state, kb_id, user.id, body.conversation_id).await?;
    if !body.approved {
        return Err(AppError::Validation("Explicit approval is required.".into()).into());
    }
    let job = research::create(
        &state.pool,
        kb_id,
        user.id,
        body.conversation_id,
        &body.query,
        body.request_id,
    )
    .await?;
    Ok(Json(job))
}

pub async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(kb_id): Path<Uuid>,
    Query(params): Query<ListParams>,
) -> ApiResult<Json<Vec<ResearchJob>>> {
    utopia_store::access::require_kb(&state.pool, &user, kb_id, Role::Viewer).await?;
    check_conversation(&state, kb_id, user.id, params.conversation_id).await?;
    Ok(Json(
        research::list(&state.pool, kb_id, user.id, params.conversation_id).await?,
    ))
}

pub async fn get(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((kb_id, job_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ResearchJob>> {
    utopia_store::access::require_kb(&state.pool, &user, kb_id, Role::Viewer).await?;
    let job = research::get(&state.pool, kb_id, job_id).await?;
    let owner: Uuid = sqlx::query_scalar("SELECT requested_by FROM research_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&state.pool)
        .await?;
    if owner != user.id {
        return Err(AppError::NotFound.into());
    }
    // Research jobs may be shared across an editor's KB, but private conversation
    // context is visible only to its owner.
    if let Some(conversation_id) = job.conversation_id {
        check_conversation(&state, kb_id, user.id, Some(conversation_id)).await?;
    }
    Ok(Json(job))
}
