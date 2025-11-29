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
import "./altair.scss";

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

const generateVideoFromWebcamDeclaration: FunctionDeclaration = {
  name: "generate_video_from_webcam",
  description: "Captures the current frame from the webcam feed and generates a video using the Veo model with the provided prompt. Use this when the user asks to make a video about what they are currently showing in the camera.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: "The text prompt describing what video to generate based on the webcam feed.",
      },
    },
    required: ["prompt"],
  },
};

const showMediaDeclaration: FunctionDeclaration = {
  name: "show_media",
  description: "Shows the most recently generated video or image on the screen. Use this after generating media when you want to display it to the user.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      mediaType: {
        type: Type.STRING,
        description: "The type of media to show: 'video' or 'image'.",
      },
    },
    required: ["mediaType"],
  },
};

const hideMediaDeclaration: FunctionDeclaration = {
  name: "hide_media",
  description: "Hides the currently displayed video or image from the screen.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
};

type RequestStatus = "pending" | "ready" | "error";

type RequestState = {
  status: RequestStatus;
  result?: any;
  error?: string;
  requestId: string;
};

type MediaDisplay = {
  type: "video" | "image";
  url: string; // Blob URL for video or data URI for image
  visible: boolean;
};

/**
 * Downloads a video from the given URI and returns a blob URL for playback
 */
async function downloadVideoAsBlob(uri: string, apiKey: string): Promise<string> {
  const url = `${uri}&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Parses the nano banana image response and extracts the base64 image data
 */
function parseImageResponse(response: any): string | null {
  try {
    // The response has a structure like: 
    // { candidates: [{ content: { parts: [{ inlineData: { data: "BASE64", mimeType: "image/jpeg" } }] } }] }
    // But it may come as a stringified JSON in the result field
    
    let data = response;
    
    // If response has a result field that's a string, parse it
    if (typeof response?.result === 'string') {
      data = JSON.parse(response.result);
    } else if (response?.response?.candidates) {
      data = response.response;
    } else if (response?.candidates) {
      data = response;
    }
    
    const candidates = data?.candidates;
    if (!candidates || candidates.length === 0) {
      console.warn('No candidates in image response');
      return null;
    }
    
    const parts = candidates[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      console.warn('No parts in image response');
      return null;
    }
    
    const inlineData = parts[0]?.inlineData;
    if (!inlineData?.data || !inlineData?.mimeType) {
      console.warn('No inline data in image response');
      return null;
    }
    
    // Return as data URI
    return `data:${inlineData.mimeType};base64,${inlineData.data}`;
  } catch (error) {
    console.error('Error parsing image response:', error);
    return null;
  }
}

/**
 * Captures a frame from the webcam video element and returns it as a base64 data URI
 */
function captureFrameFromWebcam(): string | null {
  // Find the video element with class "stream"
  const videoElement = document.querySelector(
    'video.stream'
  ) as HTMLVideoElement | null;

  if (!videoElement) {
    console.warn("No video element found for webcam capture");
    return null;
  }

  // Check if video is ready and has dimensions
  if (
    videoElement.readyState < 2 ||
    videoElement.videoWidth === 0 ||
    videoElement.videoHeight === 0
  ) {
    console.warn("Video element is not ready for capture");
    return null;
  }

  // Create a canvas to capture the frame
  const canvas = document.createElement("canvas");
  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    console.warn("Could not get canvas context");
    return null;
  }

  // Draw the current video frame to the canvas
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

  // Convert to base64 data URI
  const dataURI = canvas.toDataURL("image/jpeg", 1.0);
  return dataURI;
}

function AltairComponent() {
  const [jsonString, setJSONString] = useState<string>("");
  const { client, setConfig, setModel } = useLiveAPIContext();
  const [requestStates, setRequestStates] = useState<Map<string, RequestState>>(
    new Map()
  );
  const mediaClientRef = useRef<MediaClient | null>(null);
  
  // State for displaying generated media
  const [mediaDisplay, setMediaDisplay] = useState<MediaDisplay | null>(null);
  const [lastGeneratedVideo, setLastGeneratedVideo] = useState<{ uri: string; blobUrl?: string } | null>(null);
  const [lastGeneratedImage, setLastGeneratedImage] = useState<string | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);

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
            text: 'You are my helpful assistant. Any time I ask you for a graph call the "render_altair" function I have provided you. Dont ask for additional information just make your best judgement. When you generate a video or image, you can use the "show_media" function to display it on screen, and "hide_media" to remove it. After generating media, always offer to show it to the user.',
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
            generateVideoFromWebcamDeclaration,
            showMediaDeclaration,
            hideMediaDeclaration,
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

            // Handle show_media
            if (fc.name === showMediaDeclaration.name) {
              const mediaType = (fc.args as any).mediaType as "video" | "image";
              const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;
              
              try {
                if (mediaType === "video" && lastGeneratedVideo) {
                  setIsLoadingMedia(true);
                  
                  // Download video if we don't have a blob URL yet
                  let blobUrl = lastGeneratedVideo.blobUrl;
                  if (!blobUrl) {
                    blobUrl = await downloadVideoAsBlob(lastGeneratedVideo.uri, API_KEY);
                    setLastGeneratedVideo({ ...lastGeneratedVideo, blobUrl });
                  }
                  
                  setMediaDisplay({
                    type: "video",
                    url: blobUrl,
                    visible: true,
                  });
                  setIsLoadingMedia(false);
                  
                  return {
                    response: { output: { success: true, message: "Video is now displayed on screen." } },
                    id: fc.id!,
                    name: fc.name,
                  };
                } else if (mediaType === "image" && lastGeneratedImage) {
                  setMediaDisplay({
                    type: "image",
                    url: lastGeneratedImage,
                    visible: true,
                  });
                  
                  return {
                    response: { output: { success: true, message: "Image is now displayed on screen." } },
                    id: fc.id!,
                    name: fc.name,
                  };
                } else {
                  return {
                    response: { output: { success: false, error: `No ${mediaType} has been generated yet.` } },
                    id: fc.id!,
                    name: fc.name,
                  };
                }
              } catch (error: any) {
                setIsLoadingMedia(false);
                return {
                  response: { output: { success: false, error: error?.message || "Failed to show media" } },
                  id: fc.id!,
                  name: fc.name,
                };
              }
            }

            // Handle hide_media
            if (fc.name === hideMediaDeclaration.name) {
              setMediaDisplay(null);
              return {
                response: { output: { success: true, message: "Media has been hidden from screen." } },
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
                  
                  // Log the video URL when ready and store for display
                  if (result?.uri) {
                    console.log("Video generation complete! Video URL:", result.url);
                    console.log("Video URI:", result.uri);
                    setLastGeneratedVideo({ uri: result.uri, blobUrl: undefined });
                  }
                } else if (fc.name === generateVideoFromWebcamDeclaration.name) {
                  const prompt = (fc.args as any).prompt;
                  
                  // Capture frame from webcam
                  const frameDataURI = captureFrameFromWebcam();
                  
                  if (!frameDataURI) {
                    throw new Error(
                      "Could not capture frame from webcam. Make sure the webcam is active and showing video."
                    );
                  }
                  
                  // Parse the data URI to extract base64 and mime type
                  let imageBase64: string;
                  let imageMimeType: string = "image/jpeg";
                  
                  if (frameDataURI.startsWith("data:")) {
                    const matches = frameDataURI.match(/^data:([^;]+);base64,(.+)$/);
                    if (matches) {
                      imageMimeType = matches[1];
                      imageBase64 = matches[2];
                    } else {
                      // Fallback: extract base64 after comma
                      const commaIndex = frameDataURI.indexOf(",");
                      if (commaIndex > 0) {
                        const header = frameDataURI.substring(0, commaIndex);
                        const mimeMatch = header.match(/^data:([^;]+)/);
                        if (mimeMatch) {
                          imageMimeType = mimeMatch[1];
                        }
                        imageBase64 = frameDataURI.substring(commaIndex + 1);
                      } else {
                        throw new Error("Could not parse captured frame data");
                      }
                    }
                  } else {
                    throw new Error("Invalid frame data format");
                  }
                  
                  const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;
                  result = await mediaClientRef.current.generateVideo(
                    prompt,
                    imageBase64,
                    imageMimeType,
                    API_KEY
                  );
                  
                  // Log the video URL when ready and store for display
                  if (result?.uri) {
                    console.log("Video generation from webcam complete! Video URL:", result.url);
                    console.log("Video URI:", result.uri);
                    setLastGeneratedVideo({ uri: result.uri, blobUrl: undefined });
                  }
                } else if (fc.name === generateNanoBananaDeclaration.name) {
                  const prompt = (fc.args as any).prompt;
                  result = await mediaClientRef.current.generateNanoBanana(
                    prompt
                  );
                  
                  // Parse and store the generated image
                  const imageDataUri = parseImageResponse(result);
                  if (imageDataUri) {
                    console.log("Image generation complete!");
                    setLastGeneratedImage(imageDataUri);
                  }
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
                if (
                  (fc.name === generateVideoDeclaration.name ||
                    fc.name === generateVideoFromWebcamDeclaration.name) &&
                  result?.url
                ) {
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
  }, [client, lastGeneratedVideo, lastGeneratedImage]);

  const embedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (embedRef.current && jsonString) {
      console.log("jsonString", jsonString);
      vegaEmbed(embedRef.current, JSON.parse(jsonString));
    }
  }, [embedRef, jsonString]);

  // Cleanup blob URLs when component unmounts or media changes
  useEffect(() => {
    return () => {
      if (lastGeneratedVideo?.blobUrl) {
        URL.revokeObjectURL(lastGeneratedVideo.blobUrl);
      }
    };
  }, [lastGeneratedVideo?.blobUrl]);

  return (
    <div className="altair-container">
      <div className="vega-embed" ref={embedRef} />
      
      {/* Media Display Area */}
      {isLoadingMedia && (
        <div className="media-loading">
          <div className="loading-spinner" />
          <span>Loading media...</span>
        </div>
      )}
      
      {mediaDisplay && mediaDisplay.visible && (
        <div className="media-display">
          <button 
            className="media-close-btn"
            onClick={() => setMediaDisplay(null)}
            title="Close"
          >
            ×
          </button>
          
          {mediaDisplay.type === "video" && (
            <video
              className="generated-video"
              src={mediaDisplay.url}
              controls
              autoPlay
              loop
            />
          )}
          
          {mediaDisplay.type === "image" && (
            <img
              className="generated-image"
              src={mediaDisplay.url}
              alt="Generated"
            />
          )}
        </div>
      )}
    </div>
  );
}

export const Altair = memo(AltairComponent);
