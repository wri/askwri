"use client";

import { useState, useEffect } from "react";
import { X, AlertCircle } from "lucide-react";

interface Document {
  id: string;
  fileName: string;
  title: string;
  authors: string;
  year: number | string;
  url: string;
  summary: string;
  metadata: any;
}

interface DocumentEditModalProps {
  document: Document;
  isOpen: boolean;
  onClose: () => void;
  onSave: (metadata: any) => Promise<void>;
  isLoading: boolean;
}

export function DocumentEditModal({
  document,
  isOpen,
  onClose,
  onSave,
  isLoading,
}: DocumentEditModalProps) {
  const [formData, setFormData] = useState(document.metadata);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setFormData(document.metadata);
      setErrors({});
      setSaveError(null);
    }
  }, [isOpen, document]);

  function validate(): boolean {
    const newErrors: Record<string, string> = {};

    if (!formData["Article Title"]?.trim()) {
      newErrors["Article Title"] = "Title is required";
    } else if (formData["Article Title"].length > 200) {
      newErrors["Article Title"] = "Title must be under 200 characters";
    }

    const year = parseInt(formData["YEAR accepted"]);
    if (!year || year < 1800 || year > 2100) {
      newErrors["YEAR accepted"] = "Enter a valid year between 1800-2100";
    }

    if (formData["Attribution URL"] && !isValidUrl(formData["Attribution URL"])) {
      newErrors["Attribution URL"] = "Enter a valid URL starting with http:// or https://";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function isValidUrl(url: string): boolean {
    if (!url) return true; // Optional field
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);

    if (!validate()) return;

    try {
      await onSave(formData);
      onClose();
    } catch (error: any) {
      setSaveError(error.message || "Failed to save changes");
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between p-6 border-b bg-white z-10">
          <h2 className="text-xl font-semibold">Edit Document Metadata</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 transition-colors"
            disabled={isLoading}
          >
            <X size={24} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6">
          {saveError && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex gap-3">
              <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
              <p className="text-red-700">{saveError}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 mb-6">
            {/* Title */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Title *
              </label>
              <input
                type="text"
                value={formData["Article Title"] || ""}
                onChange={(e) =>
                  setFormData({ ...formData, "Article Title": e.target.value })
                }
                className={`w-full px-3 py-2 border rounded-lg transition-colors ${
                  errors["Article Title"]
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 hover:border-gray-400"
                }`}
                disabled={isLoading}
              />
              {errors["Article Title"] && (
                <p className="text-sm text-red-600 mt-1">{errors["Article Title"]}</p>
              )}
              <p className="text-xs text-gray-500 mt-1">
                {formData["Article Title"]?.length || 0}/200 characters
              </p>
            </div>

            {/* Authors */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Authors
              </label>
              <input
                type="text"
                value={formData["All authors"] || ""}
                onChange={(e) =>
                  setFormData({ ...formData, "All authors": e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg hover:border-gray-400 transition-colors"
                placeholder="Last, First; Last, First"
                disabled={isLoading}
              />
              <p className="text-xs text-gray-500 mt-1">
                Use semicolons to separate multiple authors
              </p>
            </div>

            {/* Year */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Year *
              </label>
              <input
                type="number"
                value={formData["YEAR accepted"] || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    "YEAR accepted": parseInt(e.target.value) || "",
                  })
                }
                className={`w-full px-3 py-2 border rounded-lg transition-colors ${
                  errors["YEAR accepted"]
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 hover:border-gray-400"
                }`}
                min={1800}
                max={2100}
                disabled={isLoading}
              />
              {errors["YEAR accepted"] && (
                <p className="text-sm text-red-600 mt-1">{errors["YEAR accepted"]}</p>
              )}
            </div>

            {/* Attribution URL */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Attribution URL
              </label>
              <input
                type="url"
                value={formData["Attribution URL"] || ""}
                onChange={(e) =>
                  setFormData({ ...formData, "Attribution URL": e.target.value })
                }
                className={`w-full px-3 py-2 border rounded-lg transition-colors ${
                  errors["Attribution URL"]
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 hover:border-gray-400"
                }`}
                placeholder="https://example.com"
                disabled={isLoading}
              />
              {errors["Attribution URL"] && (
                <p className="text-sm text-red-600 mt-1">
                  {errors["Attribution URL"]}
                </p>
              )}
            </div>

            {/* Sub-tag */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Sub-tag
              </label>
              <input
                type="text"
                value={formData["Sub-tag"] || ""}
                onChange={(e) =>
                  setFormData({ ...formData, "Sub-tag": e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg hover:border-gray-400 transition-colors"
                placeholder="e.g., Transport decarbonization"
                disabled={isLoading}
              />
            </div>

            {/* Summary */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Summary
              </label>
              <textarea
                value={formData["summary"] || ""}
                onChange={(e) =>
                  setFormData({ ...formData, "summary": e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg hover:border-gray-400 transition-colors"
                rows={4}
                placeholder="Brief summary of the document"
                disabled={isLoading}
              />
              <p className="text-xs text-gray-500 mt-1">
                {formData["summary"]?.length || 0}/2000 characters
              </p>
            </div>

            {/* File Name (read-only) */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-500 mb-1">
                File Name
              </label>
              <input
                type="text"
                value={document.fileName}
                disabled
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-600 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">
                Document ID: {document.id}
              </p>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-3 justify-end pt-4 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium text-gray-700"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors font-medium"
              disabled={isLoading}
            >
              {isLoading ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
