/**
 * FeedbackWidget Component
 *
 * Purpose: Collect user feedback on search results
 * Contract: Display thumbs up/down buttons with optional comment field
 *
 * Props:
 * - query: string - The search query
 * - mode: 'answer' | 'cite' | 'lit' | 'explain' - Current mode
 * - resultCount: number - Number of results shown
 * - hasResults: boolean - Whether there are results to give feedback on
 *
 * UI Behavior:
 * - Shows only when there are results
 * - Clicking either thumb shows comment field
 * - Submits feedback and shows thank you message
 * - Resets after submission
 */

'use client';

import React, { useState } from 'react';
import { ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface FeedbackWidgetProps {
  query: string;
  mode: 'answer' | 'cite' | 'lit' | 'explain';
  resultCount: number;
  hasResults: boolean;
}

type FeedbackState = 'idle' | 'collecting' | 'submitting' | 'submitted' | 'error';
type FeedbackType = 'positive' | 'negative' | null;

export function FeedbackWidget({ query, mode, resultCount, hasResults }: FeedbackWidgetProps) {
  const [state, setState] = useState<FeedbackState>('idle');
  const [feedbackType, setFeedbackType] = useState<FeedbackType>(null);
  const [comment, setComment] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Don't show if no results
  if (!hasResults || resultCount === 0) {
    return null;
  }

  const handleFeedbackClick = (type: 'positive' | 'negative') => {
    if (state === 'submitted') {
      // Reset for new feedback
      setState('collecting');
      setFeedbackType(type);
      setComment('');
      setErrorMessage('');
    } else {
      setFeedbackType(type);
      setState('collecting');
    }
  };

  const handleSubmit = async () => {
    if (!feedbackType) return;

    setState('submitting');
    setErrorMessage('');

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          feedbackType,
          comment: comment.trim() || undefined,
          query,
          mode,
          resultCount,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to submit feedback');
      }

      setState('submitted');
      // Reset after showing success message for a few seconds
      setTimeout(() => {
        setState('idle');
        setFeedbackType(null);
        setComment('');
      }, 3000);
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to submit feedback');
      setState('error');
      // Allow retry after showing error
      setTimeout(() => {
        setState('collecting');
      }, 3000);
    }
  };

  const handleCancel = () => {
    setState('idle');
    setFeedbackType(null);
    setComment('');
    setErrorMessage('');
  };

  // Show success message
  if (state === 'submitted') {
    return (
      <Card className="mt-6 border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-center gap-2 text-green-700 dark:text-green-300">
            <ThumbsUp className="w-4 h-4" />
            <span className="text-sm font-medium">Thanks for your feedback!</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show error message
  if (state === 'error' && errorMessage) {
    return (
      <Card className="mt-6 border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950">
        <CardContent className="pt-4 pb-4">
          <div className="text-center text-red-700 dark:text-red-300">
            <span className="text-sm">{errorMessage}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-6">
      <CardContent className="pt-4 pb-4">
        <div className="space-y-3">
          {/* Header and buttons */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Was this helpful?
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={feedbackType === 'positive' ? 'default' : 'outline'}
                className={cn(
                  feedbackType === 'positive' && 'bg-green-600 hover:bg-green-700 text-white'
                )}
                onClick={() => handleFeedbackClick('positive')}
                disabled={state === 'submitting'}
              >
                <ThumbsUp className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant={feedbackType === 'negative' ? 'default' : 'outline'}
                className={cn(
                  feedbackType === 'negative' && 'bg-red-600 hover:bg-red-700 text-white'
                )}
                onClick={() => handleFeedbackClick('negative')}
                disabled={state === 'submitting'}
              >
                <ThumbsDown className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Comment field - shown after selecting feedback */}
          {state === 'collecting' && feedbackType && (
            <div className="space-y-3">
              <textarea
                className="w-full px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                rows={3}
                placeholder={
                  feedbackType === 'positive'
                    ? "What worked well? (optional)"
                    : "What could be improved? (optional)"
                }
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
              />
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">
                  {comment.length}/500 characters
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCancel}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSubmit}
                    className="bg-gray-700 text-white hover:bg-gray-800"
                  >
                    Submit
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Loading state */}
          {state === 'submitting' && (
            <div className="flex items-center justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Submitting feedback...</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}