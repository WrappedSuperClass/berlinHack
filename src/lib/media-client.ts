/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { GoogleGenAI } from "@google/genai";

export const MODEL_VEO = "veo-3.1-generate-preview";
export const MODEL_NANO_BANANA_PRO = "nano-banana-pro-preview";
export const MODEL_TTS = "gemini-2.5-flash-preview-tts";

export class MediaClient {
    private client: GoogleGenAI;

    constructor(apiKey: string) {
        this.client = new GoogleGenAI({ apiKey });
    }

    /**
     * Generates a video using the Veo 3.1 model.
     * @param prompt The text prompt for video generation.
     * @returns The generated video content (implementation dependent on API response).
     */
    async generateVideo(prompt: string) {
        // Use the generateVideos API for video generation
        const result = await this.client.models.generateVideos({
            model: MODEL_VEO,
            prompt: prompt
        });
        return result;
    }

    /**
     * Interacts with the Nano Banana Pro model.
     * @param prompt The input prompt.
     * @returns The model response.
     */
    async generateNanoBanana(prompt: string) {
        const result = await this.client.models.generateContent({
            model: MODEL_NANO_BANANA_PRO,
            contents: prompt
        });
        return result;
    }

    /**
     * Generates speech from text using the Google TTS model.
     * @param text The text to convert to speech.
     * @returns The audio content.
     */
    async generateSpeech(text: string) {
        // TTS requires AUDIO response modality
        const result = await this.client.models.generateContent({
            model: MODEL_TTS,
            contents: text,
            config: {
                responseModalities: ['AUDIO']
            }
        });
        return result;
    }
}
