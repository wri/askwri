from sentence_transformers import CrossEncoder

# Descarga y carga el modelo oficial de HuggingFace
model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-12-v2")

# Guarda el modelo localmente en tu carpeta
model.save("models/cross-encoder-mini")
print("Modelo exportado correctamente en models/cross-encoder-mini")

