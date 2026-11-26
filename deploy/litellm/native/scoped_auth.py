"""Authenticate the single-host LiteLLM gateway without a key database."""
import os
import secrets

from fastapi import HTTPException, Request
from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth


def matches(value, variable):
    return secrets.compare_digest(value.encode(), os.environ[variable].encode())


async def authorize(request: Request) -> UserAPIKeyAuth:
    # Accept only the standard bearer header on this application gateway.
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Bearer credential required")
    route = (request.method, request.url.path)
    if matches(token, "LITELLM_MASTER_KEY"):
        return UserAPIKeyAuth(user_id="gateway-admin", user_role=LitellmUserRoles.PROXY_ADMIN)
    if matches(token, "KELIN_CALL_KEY"):
        from litellm.proxy.proxy_server import llm_router
        models = list(llm_router.get_model_names())
        if route not in {("POST", "/v1/chat/completions"), ("GET", "/v1/models")}:
            raise HTTPException(status_code=403, detail="Inference credential cannot access this route")
        if request.method == "POST":
            data = await request.json()
            allowed = {"model", "messages", "tools", "tool_choice", "stream", "stream_options",
                       "temperature", "top_p", "max_tokens", "max_completion_tokens", "stop",
                       "frequency_penalty", "presence_penalty", "parallel_tool_calls", "seed",
                       "response_format", "max_retries", "metadata"}
            if not isinstance(data, dict) or data.get("model") not in models or set(data) - allowed:
                raise HTTPException(status_code=403, detail="Model or parameter outside inference scope")
            metadata = data.get("metadata") or {}
            if not isinstance(metadata, dict) or set(metadata) - {"spend_logs_metadata"}:
                raise HTTPException(status_code=403, detail="Unsupported request metadata")
        return UserAPIKeyAuth(user_id="kelin-backend", user_role=LitellmUserRoles.INTERNAL_USER,
                              models=models)
    if matches(token, "KELIN_MODEL_ADMIN_KEY"):
        if route not in {("POST", "/model/new"), ("POST", "/model/update"), ("POST", "/model/delete")}:
            raise HTTPException(status_code=403, detail="Model configuration credential cannot access this route")
        return UserAPIKeyAuth(user_id="kelin-model-manager", user_role=LitellmUserRoles.PROXY_ADMIN)
    raise HTTPException(status_code=401, detail="Invalid bearer credential")


async def authenticate(request: Request, api_key: str) -> UserAPIKeyAuth:
    return request.state.kelin_identity
