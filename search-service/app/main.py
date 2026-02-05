import logging
from contextlib import asynccontextmanager
from datetime import datetime

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routers import api

settings = get_settings()

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup and shutdown events."""
    # Startup
    logger.info(f"Starting Search Service - Environment: {settings.environment}")
    logger.info(f"Next.js Backend URL: {settings.nextjs_backend_url}")
    
    # Initialize HTTP client for communicating with Next.js backend
    app.state.http_client = httpx.AsyncClient(
        base_url=settings.nextjs_backend_url,
        timeout=30.0,
    )
    
    yield
    
    # Shutdown
    logger.info("Shutting down Search Service")
    await app.state.http_client.aclose()


app = FastAPI(
    title="AskWRI Search Service",
    description="Search service for AskWRI application",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/search/docs",
    openapi_url="/api/search/openapi.json",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Health check endpoint (root level for ALB health checks)
@app.get("/health")
async def health_check():
    """Health check endpoint for ALB and container health checks."""
    return {
        "status": "healthy",
        "service": "search-service",
        "environment": settings.environment,
        "timestamp": datetime.utcnow().isoformat(),
    }


# Include API routers
app.include_router(api.router, prefix="/api/search")


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "detail": str(exc) if settings.debug else "An unexpected error occurred",
        },
    )


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.debug,
        workers=settings.workers if not settings.debug else 1,
    )
