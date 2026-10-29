"""
NudeNet NSFW Detection API
Lightweight FastAPI wrapper for NudeNet nude detection
"""

import io
import os
import tempfile
from typing import Optional
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from nudenet import NudeDetector
from PIL import Image

app = FastAPI(
    title="NudeNet NSFW Detection API",
    description="Detects nudity and inappropriate content in images",
    version="1.0.0"
)

# Initialize detector once at startup (loads ONNX model)
detector = None

# NSFW class labels that should trigger blocking
# These are the classes NudeNet can detect:
# FEMALE_BREAST_EXPOSED, FEMALE_GENITALIA_EXPOSED, MALE_GENITALIA_EXPOSED,
# BUTTOCKS_EXPOSED, ANUS_EXPOSED, FEET_EXPOSED, BELLY_EXPOSED,
# ARMPITS_EXPOSED, FEMALE_BREAST_COVERED, FEMALE_GENITALIA_COVERED,
# MALE_GENITALIA_COVERED, BUTTOCKS_COVERED, ANUS_COVERED, BELLY_COVERED

# High severity - always block
HIGH_SEVERITY_CLASSES = {
    'FEMALE_BREAST_EXPOSED',
    'FEMALE_GENITALIA_EXPOSED', 
    'MALE_GENITALIA_EXPOSED',
    'ANUS_EXPOSED',
    'BUTTOCKS_EXPOSED'
}

# Medium severity - block if confidence is high
MEDIUM_SEVERITY_CLASSES = {
    'FEMALE_BREAST_COVERED',
    'FEMALE_GENITALIA_COVERED',
    'MALE_GENITALIA_COVERED'
}

# Configurable thresholds via environment variables
HIGH_SEVERITY_THRESHOLD = float(os.environ.get('NSFW_HIGH_THRESHOLD', '0.45'))
MEDIUM_SEVERITY_THRESHOLD = float(os.environ.get('NSFW_MEDIUM_THRESHOLD', '0.70'))


@app.on_event("startup")
async def load_model():
    """Load NudeNet model on startup"""
    global detector
    print("[NudeNet] Loading detection model...")
    detector = NudeDetector()
    print("[NudeNet] Model loaded successfully")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model_loaded": detector is not None,
        "thresholds": {
            "high_severity": HIGH_SEVERITY_THRESHOLD,
            "medium_severity": MEDIUM_SEVERITY_THRESHOLD
        }
    }


@app.post("/detect")
async def detect_nsfw(file: UploadFile = File(...)):
    """
    Detect NSFW content in uploaded image
    
    Returns:
        - is_nsfw: bool - True if image should be blocked
        - score: float - Highest NSFW confidence score
        - reason: str - Human readable reason (if NSFW)
        - detections: list - All detected body parts with scores
    """
    if not detector:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    try:
        # Read and validate image
        contents = await file.read()
        
        # Verify it's a valid image
        try:
            img = Image.open(io.BytesIO(contents))
            img.verify()
        except Exception as e:
            return JSONResponse(
                status_code=400,
                content={"error": f"Invalid image: {str(e)}"}
            )
        
        # Save to temp file (NudeNet requires file path)
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp:
            tmp.write(contents)
            tmp_path = tmp.name
        
        try:
            # Run detection
            detections = detector.detect(tmp_path)
        finally:
            # Clean up temp file
            os.unlink(tmp_path)
        
        # Analyze detections
        is_nsfw = False
        highest_score = 0.0
        nsfw_reason = None
        detected_classes = []
        
        for detection in detections:
            class_name = detection['class']
            score = detection['score']
            
            detected_classes.append({
                'class': class_name,
                'score': round(score, 3),
                'box': detection.get('box', [])
            })
            
            # Check high severity classes
            if class_name in HIGH_SEVERITY_CLASSES and score >= HIGH_SEVERITY_THRESHOLD:
                is_nsfw = True
                if score > highest_score:
                    highest_score = score
                    nsfw_reason = f"{class_name} detected ({score:.1%})"
            
            # Check medium severity classes (need higher confidence)
            elif class_name in MEDIUM_SEVERITY_CLASSES and score >= MEDIUM_SEVERITY_THRESHOLD:
                is_nsfw = True
                if score > highest_score:
                    highest_score = score
                    nsfw_reason = f"{class_name} detected ({score:.1%})"
        
        return {
            "is_nsfw": is_nsfw,
            "score": round(highest_score, 3),
            "reason": nsfw_reason,
            "detections": detected_classes,
            "thresholds_used": {
                "high_severity": HIGH_SEVERITY_THRESHOLD,
                "medium_severity": MEDIUM_SEVERITY_THRESHOLD
            }
        }
        
    except Exception as e:
        print(f"[NudeNet] Detection error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")


@app.get("/")
async def root():
    """API info endpoint"""
    return {
        "service": "NudeNet NSFW Detection API",
        "version": "1.0.0",
        "endpoints": {
            "/health": "Health check",
            "/detect": "POST - Upload image for NSFW detection"
        },
        "classes_detected": {
            "high_severity": list(HIGH_SEVERITY_CLASSES),
            "medium_severity": list(MEDIUM_SEVERITY_CLASSES)
        }
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
