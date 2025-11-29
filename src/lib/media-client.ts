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

//export const MODEL_VEO = "veo-3.1-generate-preview";
export const MODEL_VEO = "models/veo-2.0-generate-001";
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
     * @param imageBase64 Optional base64-encoded image to use as a starting frame.
     * @param imageMimeType Optional MIME type of the image (e.g., "image/png", "image/jpeg").
     * @param apiKey API key needed to fetch the video from the URI.
     * @returns Object containing the video URI and URL for viewing.
     */
    async generateVideo(
        prompt: string,
        imageBase64?: string,
        imageMimeType?: string,
        apiKey?: string
    ) {
        const config: any = {
            numberOfVideos: 1,
        };

        const generateVideoPayload: any = {
            model: MODEL_VEO,
            config: config,
        };

        // Construct the prompt with instruction to ignore humans
        let finalPrompt = prompt;
        if (prompt) {
            // Add instruction to ignore humans and only use objects when an image is provided
            if (imageBase64 && imageMimeType) {
                finalPrompt = `${prompt} IMPORTANT: Completely ignore any humans in the image. Only use objects and the environment for video generation. Do not include any human figures or body parts in the generated video.`;
            }
            generateVideoPayload.prompt = finalPrompt;
        }

        // Add image if provided (for frames-to-video mode)
        if (imageBase64 && imageMimeType) {
            generateVideoPayload.image = {
                imageBytes: imageBase64,
                mimeType: imageMimeType,
            };
        }

        console.log('Submitting video generation request...', generateVideoPayload);
        let operation = await this.client.models.generateVideos(generateVideoPayload);
        console.log('Video generation operation started:', operation);

        // Poll until the operation is done
        while (!operation.done) {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            console.log('...Generating...');
            operation = await this.client.operations.getVideosOperation({ operation: operation });
        }

        if (operation?.response) {
            const videos = operation.response.generatedVideos;

            if (!videos || videos.length === 0) {
                throw new Error('No videos were generated.');
            }

            const firstVideo = videos[0];
            if (!firstVideo?.video?.uri) {
                throw new Error('Generated video is missing a URI.');
            }

            const videoObject = firstVideo.video;
            // We've already checked that uri exists above
            const uri = decodeURIComponent(videoObject.uri!);
            console.log('Video generation complete. URI:', uri);

            // Construct the URL with API key if provided
            let url = uri;
            if (apiKey && typeof apiKey === 'string') {
                url = `${uri}&key=${apiKey}`;
                console.log('Video generation complete. URL:', url);
            }

            return {
                uri: uri,
                url: url,
                video: videoObject,
            };
        } else {
            console.error('Operation failed:', operation);
            throw new Error('No videos generated.');
        }
    }

    /**
     * Interacts with the Nano Banana Pro model TO GENERATE IMAGES.
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
