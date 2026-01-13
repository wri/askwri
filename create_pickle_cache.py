#!/usr/bin/env python3
"""
One-time script to create pickle cache from existing JSON vector store
"""
import json
import pickle
from pathlib import Path

# Find the vector index directory
cache_dir = Path("hybrid-service/cache/indexes")
vector_dirs = list(cache_dir.glob("*_vector_index"))

if not vector_dirs:
    print("❌ No vector index found in cache/indexes/")
    exit(1)

vector_dir = vector_dirs[0]
print(f"📦 Found vector index: {vector_dir.name}")

# Load the JSON embeddings
json_path = vector_dir / "default__vector_store.json"
pickle_path = vector_dir / "embeddings.pkl"

if pickle_path.exists():
    print(f"✅ Pickle file already exists: {pickle_path}")
    exit(0)

print(f"📖 Reading JSON embeddings from {json_path.name}...")
print(f"   ⏳ This may take 1-2 minutes for 1GB file...")

with open(json_path, 'r') as f:
    data = json.load(f)

embeddings_dict = data.get('embedding_dict', {})
print(f"✅ Loaded {len(embeddings_dict)} embeddings")

print(f"💾 Writing pickle cache to {pickle_path.name}...")
with open(pickle_path, 'wb') as f:
    pickle.dump(embeddings_dict, f, protocol=pickle.HIGHEST_PROTOCOL)

pickle_size_mb = pickle_path.stat().st_size / (1024**2)
json_size_mb = json_path.stat().st_size / (1024**2)

print(f"✅ Pickle cache created!")
print(f"   📊 JSON size: {json_size_mb:.1f} MB")
print(f"   📊 Pickle size: {pickle_size_mb:.1f} MB")
print(f"   🚀 Size reduction: {((json_size_mb - pickle_size_mb) / json_size_mb * 100):.1f}%")
print(f"\n✨ Next startup should be 5-10x faster!")
