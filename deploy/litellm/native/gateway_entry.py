from fastapi import HTTPException
from starlette.responses import JSONResponse
from litellm.proxy.proxy_server import app
from scoped_auth import authorize


@app.middleware("http")
async def check_gateway_access(request, call_next):
    if (request.method, request.url.path) != ("GET", "/health/liveliness"):
        try:
            request.state.kelin_identity = await authorize(request)
        except HTTPException as error:
            headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else {}
            return JSONResponse({"error": {"message": error.detail}}, status_code=error.status_code, headers=headers)
        except (ValueError, UnicodeDecodeError):
            return JSONResponse({"error": {"message": "Invalid JSON body"}}, status_code=400)
    return await call_next(request)
