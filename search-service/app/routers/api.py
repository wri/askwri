import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["API"])


# =============================================================================
# Request/Response Models
# =============================================================================

class MessageRequest(BaseModel):
    """Request model for processing messages."""
    message: str
    context: Optional[dict[str, Any]] = None


class MessageResponse(BaseModel):
    """Response model for processed messages."""
    response: str
    processed_at: str
    metadata: Optional[dict[str, Any]] = None


class ProcessRequest(BaseModel):
    """Request model for data processing."""
    data: dict[str, Any]
    operation: str = "default"


class ProcessResponse(BaseModel):
    """Response model for processed data."""
    result: dict[str, Any]
    operation: str
    processed_at: str


class NextJSHealthResponse(BaseModel):
    """Response model for Next.js health check."""
    nextjs_status: str
    nextjs_response: Optional[dict[str, Any]] = None
    python_status: str = "healthy"


# =============================================================================
# API Endpoints
# =============================================================================

@router.get("")
@router.get("/")
async def root():
    """Root endpoint for the Python API."""
    return {
        "service": "askwri-search-service",
        "version": "1.0.0",
        "status": "running",
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/health")
async def api_health(settings: Settings = Depends(get_settings)):
    """API-level health check endpoint."""
    return {
        "status": "healthy",
        "service": "search-service",
        "environment": settings.environment,
        "debug": settings.debug,
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/nextjs-health")
async def check_nextjs_health(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> NextJSHealthResponse:
    """Check connectivity to Next.js backend."""
    try:
        http_client = request.app.state.http_client
        response = await http_client.get("/api/health")
        response.raise_for_status()
        
        return NextJSHealthResponse(
            nextjs_status="healthy",
            nextjs_response=response.json(),
            python_status="healthy",
        )
    except Exception as e:
        logger.warning(f"Failed to reach Next.js backend: {e}")
        return NextJSHealthResponse(
            nextjs_status="unreachable",
            nextjs_response={"error": str(e)},
            python_status="healthy",
        )


@router.post("/message", response_model=MessageResponse)
async def process_message(
    payload: MessageRequest,
    settings: Settings = Depends(get_settings),
):
    """
    Process a message from the Next.js frontend.
    
    This is a stub endpoint - implement your business logic here.
    """
    logger.info(f"Processing message: {payload.message[:50]}...")
    
    # TODO: Implement your message processing logic here
    # Example: AI processing, database queries, external API calls, etc.
    
    return MessageResponse(
        response=f"Processed: {payload.message}",
        processed_at=datetime.utcnow().isoformat(),
        metadata={
            "environment": settings.environment,
            "context_provided": payload.context is not None,
        },
    )


@router.post("/process", response_model=ProcessResponse)
async def process_data(
    payload: ProcessRequest,
    settings: Settings = Depends(get_settings),
):
    """
    Process data with specified operation.
    
    This is a stub endpoint - implement your data processing logic here.
    """
    logger.info(f"Processing data with operation: {payload.operation}")
    
    # TODO: Implement your data processing logic here
    # Example: ML inference, data transformation, analytics, etc.
    
    result = {
        "input_keys": list(payload.data.keys()),
        "operation_applied": payload.operation,
        "processed": True,
    }
    
    return ProcessResponse(
        result=result,
        operation=payload.operation,
        processed_at=datetime.utcnow().isoformat(),
    )


@router.get("/config")
async def get_config(settings: Settings = Depends(get_settings)):
    """Get non-sensitive configuration information."""
    return {
        "environment": settings.environment,
        "debug": settings.debug,
        "log_level": settings.log_level,
        "workers": settings.workers,
    }
