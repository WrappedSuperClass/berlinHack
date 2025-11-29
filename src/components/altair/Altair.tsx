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
import { useEffect, useRef, useState, memo } from "react";
import vegaEmbed from "vega-embed";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import {
  FunctionDeclaration,
  LiveServerToolCall,
  Modality,
  Type,
} from "@google/genai";
import { MediaClient } from "../../lib/media-client";

const declaration: FunctionDeclaration = {
  name: "render_altair",
  description: "Displays an altair graph in json format.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      json_graph: {
        type: Type.STRING,
        description:
          "JSON STRING representation of the graph to render. Must be a string, not a json object",
      },
    },
    required: ["json_graph"],
  },
};

const generateVideoDeclaration: FunctionDeclaration = {
  name: "generate_video",
  description: "Generates a video using the Veo 3.1 model based on a text prompt. Can optionally use an image as a starting frame.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: "The text prompt describing the video to generate.",
      },
      imageBase64: {
        type: Type.STRING,
        description: "Optional base64-encoded image to use as a starting frame for the video. Should include the data URI prefix (e.g., 'data:image/jpeg;base64,...').",
      },
    },
    required: ["prompt"],
  },
};

const generateNanoBananaDeclaration: FunctionDeclaration = {
  name: "generate_nano_banana",
  description: "Interacts with the Nano Banana Pro model to generate content based on a prompt.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: "The input prompt for the Nano Banana Pro model.",
      },
    },
    required: ["prompt"],
  },
};

const generateSpeechDeclaration: FunctionDeclaration = {
  name: "generate_speech",
  description: "Generates speech audio from text using the Google TTS model.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      text: {
        type: Type.STRING,
        description: "The text to convert to speech.",
      },
    },
    required: ["text"],
  },
};

type RequestStatus = "pending" | "ready" | "error";

type RequestState = {
  status: RequestStatus;
  result?: any;
  error?: string;
  requestId: string;
};

function AltairComponent() {
  const [jsonString, setJSONString] = useState<string>("");
  const { client, setConfig, setModel } = useLiveAPIContext();
  const [requestStates, setRequestStates] = useState<Map<string, RequestState>>(
    new Map()
  );
  const mediaClientRef = useRef<MediaClient | null>(null);

  useEffect(() => {
    setModel("models/gemini-2.0-flash-exp");
    setConfig({
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
      },
      systemInstruction: {
        parts: [
          {
            text: 'You are my helpful assistant. Any time I ask you for a graph call the "render_altair" function I have provided you. Dont ask for additional information just make your best judgement.',
          },
        ],
      },
      tools: [
        // there is a free-tier quota for search
        { googleSearch: {} },
        {
          functionDeclarations: [
            declaration,
            generateVideoDeclaration,
            generateNanoBananaDeclaration,
            generateSpeechDeclaration,
          ],
        },
      ],
    });
  }, [setConfig, setModel]);

  // Initialize MediaClient
  useEffect(() => {
    const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;
    if (API_KEY && !mediaClientRef.current) {
      mediaClientRef.current = new MediaClient(API_KEY);
    }
  }, []);

  useEffect(() => {
    const onToolCall = async (toolCall: LiveServerToolCall) => {
      if (!toolCall.functionCalls) {
        return;
      }

      // Handle render_altair
      const altairFc = toolCall.functionCalls.find(
        (fc) => fc.name === declaration.name
      );
      if (altairFc) {
        const str = (altairFc.args as any).json_graph;
        setJSONString(str);
      }

      // Process all function calls and wait for async operations to complete
      const functionResponses = await Promise.all(
        toolCall.functionCalls
          .filter((fc) => fc.id) // Ensure id exists
          .map(async (fc) => {
            // Handle render_altair - immediate response
            if (fc.name === declaration.name) {
              return {
                response: { output: { success: true } },
                id: fc.id!,
                name: fc.name,
              };
            }

            // For media client calls, track state and process async
            const requestId = `${fc.name}_${fc.id}_${Date.now()}`;
            
            // Update state to pending (for UI/logging)
            setRequestStates((prev) => {
              const newMap = new Map(prev);
              newMap.set(requestId, {
                status: "pending",
                requestId,
              });
              return newMap;
            });

            // Process async operations
            if (mediaClientRef.current) {
              try {
                let result: any;
                if (fc.name === generateVideoDeclaration.name) {
                  const prompt = (fc.args as any).prompt;
                  const imageBase64Arg = (fc.args as any).imageBase64;
                  
                  // Parse image data if provided
                  let imageBase64: string | undefined;
                  let imageMimeType: string | undefined;
                  
                  if (imageBase64Arg) {
                    // Handle data URI format: "data:image/jpeg;base64,..." or just base64 string
                    if (imageBase64Arg.startsWith("data:")) {
                      const matches = imageBase64Arg.match(/^data:([^;]+);base64,(.+)$/);
                      if (matches) {
                        imageMimeType = matches[1];
                        imageBase64 = matches[2];
                      } else {
                        // Fallback: try to extract from any data URI format
                        const commaIndex = imageBase64Arg.indexOf(",");
                        if (commaIndex > 0) {
                          const header = imageBase64Arg.substring(0, commaIndex);
                          const mimeMatch = header.match(/^data:([^;]+)/);
                          if (mimeMatch) {
                            imageMimeType = mimeMatch[1];
                          }
                          imageBase64 = imageBase64Arg.substring(commaIndex + 1);
                        }
                      }
                    } else {
                      // Assume it's just base64 data, default to jpeg
                      imageBase64 = imageBase64Arg;
                      imageMimeType = "image/jpeg";
                    }
                  }
                  
                  const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;
                  result = await mediaClientRef.current.generateVideo(
                    prompt,
                    imageBase64,
                    imageMimeType,
                    API_KEY
                  );
                  
                  // Log the video URL when ready
                  if (result?.url) {
                    console.log("Video generation complete! Video URL:", result.url);
                    console.log("Video URI:", result.uri);
                  }
                } else if (fc.name === generateNanoBananaDeclaration.name) {
                  const prompt = (fc.args as any).prompt;
                  result = await mediaClientRef.current.generateNanoBanana(
                    prompt
                  );
                } else if (fc.name === generateSpeechDeclaration.name) {
                  const text = (fc.args as any).text;
                  result = await mediaClientRef.current.generateSpeech(text);
                }

                // Update state to ready
                setRequestStates((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(requestId, {
                    status: "ready",
                    result,
                    requestId,
                  });
                  return newMap;
                });

                // Return response with ready status (without result data to keep response small)
                let message = "Request completed successfully";
                if (fc.name === generateVideoDeclaration.name && result?.url) {
                  // Include URL in message for video generation
                  message = `Video generation complete. URL: ${result.url}`;
                }
                
                return {
                  response: {
                    output: {
                      status: "ready" as RequestStatus,
                      requestId,
                      message,
                    },
                  },
                  id: fc.id!,
                  name: fc.name,
                };
              } catch (error: any) {
                // Update state to error
                setRequestStates((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(requestId, {
                    status: "error",
                    error: error?.message || "Unknown error",
                    requestId,
                  });
                  return newMap;
                });

                // Return error response
                return {
                  response: {
                    output: {
                      status: "error" as RequestStatus,
                      requestId,
                      error: error?.message || "Unknown error",
                      message: "Request failed",
                    },
                  },
                  id: fc.id!,
                  name: fc.name,
                };
              }
            }

            // Fallback for non-media-client calls
            return {
              response: {
                output: {
                  status: "error" as RequestStatus,
                  requestId,
                  error: "MediaClient not initialized",
                  message: "Request failed",
                },
              },
              id: fc.id!,
              name: fc.name,
            };
          })
      );

      // Send all responses after async operations complete
      client.sendToolResponse({
        functionResponses,
      });
    };

    client.on("toolcall", onToolCall);
    return () => {
      client.off("toolcall", onToolCall);
    };
  }, [client]);

  const embedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (embedRef.current && jsonString) {
      console.log("jsonString", jsonString);
      vegaEmbed(embedRef.current, JSON.parse(jsonString));
    }
  }, [embedRef, jsonString]);
  return <div className="vega-embed" ref={embedRef} />;
}

export const Altair = memo(AltairComponent);
