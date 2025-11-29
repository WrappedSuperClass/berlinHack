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
import { useEffect, useRef, useState, memo, useCallback } from "react";
import vegaEmbed from "vega-embed";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { useFunctionAPIContext } from "../../contexts/FunctionAPIContext";
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

// 1) Generate a cartoon / explainer VIDEO from text (optionally using an image as first frame)
const generateVideoDeclaration: FunctionDeclaration = {
  name: "generate_video",
  description:
    "Generates a short, kid-friendly explainer or cartoon video using the Veo 3.1 model based on a text prompt. Can optionally use an image as a starting frame.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description:
          "A clear, detailed text prompt describing the video to generate. Mention that it should be simple, colorful, and easy for children to understand.",
      },
      imageBase64: {
        type: Type.STRING,
        description:
          "Optional base64-encoded image to use as a starting frame for the video (for example, a previously generated explainer image). Should include the data URI prefix (e.g., 'data:image/jpeg;base64,...').",
      },
    },
    required: ["prompt"],
  },
};

// 2) IMAGE GENERATION
const generateImageDeclaration: FunctionDeclaration = {
  name: "generate_image",
  description:
    "Generates one or more kid-friendly images based on a text prompt. Use this for explanation pictures (e.g., why the sky is blue), still frames of a favorite toy, or simple cartoon scenes.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description:
          "A clear, detailed text prompt describing the image(s) to generate. Mention that the style should be simple, colorful, and easy for children to understand.",
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

// 3) Generate a VIDEO based on what the child is showing on the webcam (toy, Lego, etc.)
const generateVideoFromWebcamDeclaration: FunctionDeclaration = {
  name: "generate_video_from_webcam",
  description:
    "Captures the current frame from the webcam feed and generates a kid-friendly video using the Veo model with the provided prompt. Use this when the child asks to make a cartoon about what they are currently showing in the camera (for example, their favorite toy or a Lego tower).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description:
          "A text prompt describing what video to generate based on the webcam frame, including how the shown object should move or act in the cartoon or explainer.",
      },
    },
    required: ["prompt"],
  },
};

// 4) Show the latest generated media (image or video)
const showMediaDeclaration: FunctionDeclaration = {
  name: "show_media",
  description:
    "Shows the most recently generated video or image on the screen. Use this after generating media when you want to display it to the child.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      mediaType: {
        type: Type.STRING,
        description: "The type of media to show: 'video' or 'image'. Call it right after the media is generated.",
      },
    },
    required: ["mediaType"],
  },
};

// 5) Hide whatever is currently displayed
const hideMediaDeclaration: FunctionDeclaration = {
  name: "hide_media",
  description:
    "Hides the currently displayed video or image from the screen.",
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
    let data = response;
    
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
  const videoElement = document.querySelector(
    'video.stream'
  ) as HTMLVideoElement | null;

  if (!videoElement) {
    console.warn("No video element found for webcam capture");
    return null;
  }

  if (
    videoElement.readyState < 2 ||
    videoElement.videoWidth === 0 ||
    videoElement.videoHeight === 0
  ) {
    console.warn("Video element is not ready for capture");
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    console.warn("Could not get canvas context");
    return null;
  }

  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  const dataURI = canvas.toDataURL("image/jpeg", 1.0);
  return dataURI;
}

function AltairComponent() {
  const [jsonString, setJSONString] = useState<string>("");
  
  // Speaking model - handles conversation with audio output
  const { client: speakingClient, setConfig: setSpeakingConfig, setModel: setSpeakingModel } = useLiveAPIContext();
  
  // Function model - handles function calling (no audio output)
  const { client: functionClient, setConfig: setFunctionConfig, setModel: setFunctionModel } = useFunctionAPIContext();
  
  const [requestStates, setRequestStates] = useState<Map<string, RequestState>>(
    new Map()
  );
  const mediaClientRef = useRef<MediaClient | null>(null);
  
  // State for displaying generated media
  const [mediaDisplay, setMediaDisplay] = useState<MediaDisplay | null>(null);
  const [lastGeneratedVideo, setLastGeneratedVideo] = useState<{ uri: string; blobUrl?: string } | null>(null);
  const [lastGeneratedImage, setLastGeneratedImage] = useState<string | null>(null);
  const [isLoadingMedia, setIsLoadingMedia] = useState(false);
  
  // Track if media generation is in progress
  const [isGeneratingMedia, setIsGeneratingMedia] = useState(false);
  const [generatingMediaType, setGeneratingMediaType] = useState<"image" | "video" | null>(null);

  // Notify the speaking model about events (media ready, etc.)
  const notifySpeakingModel = useCallback((message: string) => {
    console.log("[Notify Speaking Model]:", message);
    // Send a text message to the speaking model so it knows what happened
    speakingClient.send({ text: `[SYSTEM NOTIFICATION]: ${message}` }, false);
  }, [speakingClient]);

  // Configure the SPEAKING model (audio output, no function declarations)
  useEffect(() => {
    setSpeakingModel("models/gemini-2.0-flash-exp");
    setSpeakingConfig({
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
      },
      systemInstruction: {
        parts: [
          {
            text: `You are a friendly, enthusiastic explainer for children. Your ONLY job is to TALK and explain things in a fun, engaging way.

CRITICAL: WAIT for the child to speak FIRST before saying anything! Do not start talking on your own.

IMPORTANT RULES:
1. WAIT for the child to ask a question or say something before responding
2. When the child asks a question, start explaining it in great detail. Talk for at least 2-3 minutes continuously.
3. Use a warm, excited tone. Say things like "Oh, what a wonderful question! Let me tell you all about..."
4. You will receive SYSTEM NOTIFICATIONS about media (images, videos) being generated or displayed. When you see these notifications, naturally incorporate them into your conversation, like "Oh look! The picture is ready! Can you see it on the screen?"
5. NEVER stop talking while waiting for something. Keep explaining, telling related stories, or asking the child questions.
6. If you're notified that a cartoon/image is ready, get excited and describe what might be in it while the child looks at it.

Example flow:
- [WAIT for the child to speak first]
- Child asks: "Why is the sky blue?"
- You start: "Oh, what a wonderful question! The sky is blue because of something magical called light scattering! You see, sunlight looks white, but it's actually made of ALL the colors of the rainbow mixed together! When sunlight enters our atmosphere..."
- [You receive notification: Image is being generated]
- You continue: "...and guess what? I'm making a special picture for you right now to help explain this! While it's being created, let me tell you more about how this works..."
- [You receive notification: Image is ready and displayed]
- You say: "Oh wonderful! Look at the screen! Can you see the picture? It shows how the light bounces around in our atmosphere..."

Remember: WAIT for the child to speak first, then keep talking and explaining. Other systems handle the image/video generation - you just talk!`,
          },
        ],
      },
      // NO tools for the speaking model - it just talks
    });
  }, [setSpeakingConfig, setSpeakingModel]);

  // Configure the FUNCTION model (text output, all function declarations)
  useEffect(() => {
    setFunctionModel("models/gemini-2.0-flash-exp");
    setFunctionConfig({
      responseModalities: [Modality.TEXT], // TEXT only, no audio
      systemInstruction: {
        parts: [
          {
            text: `You are a silent assistant that ONLY calls functions when a child EXPLICITLY asks a question or makes a request.

CRITICAL RULES - READ CAREFULLY:
1. DO NOTHING until the child speaks and asks a clear question or makes a request
2. NEVER call any function on startup, on connection, or when there's silence
3. WAIT for actual spoken words from the child before doing anything
4. If you only hear background noise, silence, or unclear audio - DO NOTHING
5. You are SILENT - never output text responses, only call functions when needed

WHEN TO ACT:
- Child asks a question like "Why is the sky blue?" → Call generate_image with a relevant prompt, then show_media
- Child asks for a cartoon/video → Call generate_video, then show_media
- Child asks to see something on webcam → Call generate_video_from_webcam, then show_media
- Child asks to hide the picture → Call hide_media

WHEN TO DO NOTHING:
- Connection just started (WAIT for the child to speak)
- Only background noise or unclear audio
- The child is just making sounds but not asking anything
- The child is laughing or making non-verbal sounds

Remember: Be PATIENT. Wait for a CLEAR question or request before calling any function.`,
          },
        ],
      },
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [
            declaration,
            generateVideoDeclaration,
            generateImageDeclaration,
            generateSpeechDeclaration,
            generateVideoFromWebcamDeclaration,
            showMediaDeclaration,
            hideMediaDeclaration,
          ],
        },
      ],
    });
  }, [setFunctionConfig, setFunctionModel]);

  // Initialize MediaClient
  useEffect(() => {
    const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;
    if (API_KEY && !mediaClientRef.current) {
      mediaClientRef.current = new MediaClient(API_KEY);
    }
  }, []);

  // Handle tool calls from the FUNCTION model
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

      // Process all function calls
      const functionResponses = await Promise.all(
        toolCall.functionCalls
          .filter((fc) => fc.id)
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
                  
                  // Notify speaking model
                  notifySpeakingModel("The cartoon video is now displayed on screen! Describe it to the child and ask if they like it.");
                  
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
                  
                  // Notify speaking model
                  notifySpeakingModel("The picture is now displayed on screen! Describe it to the child and continue explaining.");
                  
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
              notifySpeakingModel("The media has been hidden from the screen.");
              return {
                response: { output: { success: true, message: "Media has been hidden from screen." } },
                id: fc.id!,
                name: fc.name,
              };
            }

            // For media client calls, track state and process async
            const requestId = `${fc.name}_${fc.id}_${Date.now()}`;
            
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
                  
                  // Notify speaking model that video generation started
                  setIsGeneratingMedia(true);
                  setGeneratingMediaType("video");
                  notifySpeakingModel("I'm now creating a special cartoon video for you! This will take a moment, so let me tell you more while we wait...");
                  
                  let imageBase64: string | undefined;
                  let imageMimeType: string | undefined;
                  
                  if (imageBase64Arg) {
                    if (imageBase64Arg.startsWith("data:")) {
                      const matches = imageBase64Arg.match(/^data:([^;]+);base64,(.+)$/);
                      if (matches) {
                        imageMimeType = matches[1];
                        imageBase64 = matches[2];
                      } else {
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
                  
                  if (result?.uri) {
                    console.log("Video generation complete! Video URI:", result.uri);
                    setLastGeneratedVideo({ uri: result.uri, blobUrl: undefined });
                    setIsGeneratingMedia(false);
                    setGeneratingMediaType(null);
                    notifySpeakingModel("Wonderful news! The cartoon video is ready! Let me show it to you!");
                  }
                } else if (fc.name === generateVideoFromWebcamDeclaration.name) {
                  const prompt = (fc.args as any).prompt;
                  
                  setIsGeneratingMedia(true);
                  setGeneratingMediaType("video");
                  notifySpeakingModel("I'm creating a special cartoon from what you're showing me! This is so exciting! While we wait, let me tell you about what makes this so cool...");
                  
                  const frameDataURI = captureFrameFromWebcam();
                  
                  if (!frameDataURI) {
                    throw new Error(
                      "Could not capture frame from webcam. Make sure the webcam is active and showing video."
                    );
                  }
                  
                  let imageBase64: string;
                  let imageMimeType: string = "image/jpeg";
                  
                  if (frameDataURI.startsWith("data:")) {
                    const matches = frameDataURI.match(/^data:([^;]+);base64,(.+)$/);
                    if (matches) {
                      imageMimeType = matches[1];
                      imageBase64 = matches[2];
                    } else {
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
                  
                  if (result?.uri) {
                    console.log("Video generation from webcam complete! Video URI:", result.uri);
                    setLastGeneratedVideo({ uri: result.uri, blobUrl: undefined });
                    setIsGeneratingMedia(false);
                    setGeneratingMediaType(null);
                    notifySpeakingModel("Amazing! Your personalized cartoon is ready! I'm so excited to show you!");
                  }
                } else if (fc.name === generateImageDeclaration.name) {
                  const prompt = (fc.args as any).prompt;
                  
                  setIsGeneratingMedia(true);
                  setGeneratingMediaType("image");
                  notifySpeakingModel("I'm drawing a special picture for you right now! It'll be ready in just a moment...");
                  
                  result = await mediaClientRef.current.generateImage(prompt);
                  
                  const imageDataUri = parseImageResponse(result);
                  if (imageDataUri) {
                    console.log("Image generation complete!");
                    setLastGeneratedImage(imageDataUri);
                    setIsGeneratingMedia(false);
                    setGeneratingMediaType(null);
                    notifySpeakingModel("The picture is ready! Let me show it to you!");
                  }
                } else if (fc.name === generateSpeechDeclaration.name) {
                  const text = (fc.args as any).text;
                  result = await mediaClientRef.current.generateSpeech(text);
                }

                setRequestStates((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(requestId, {
                    status: "ready",
                    result,
                    requestId,
                  });
                  return newMap;
                });

                let message = "Request completed successfully";
                if (
                  (fc.name === generateVideoDeclaration.name ||
                    fc.name === generateVideoFromWebcamDeclaration.name) &&
                  result?.url
                ) {
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
                setIsGeneratingMedia(false);
                setGeneratingMediaType(null);
                
                setRequestStates((prev) => {
                  const newMap = new Map(prev);
                  newMap.set(requestId, {
                    status: "error",
                    error: error?.message || "Unknown error",
                    requestId,
                  });
                  return newMap;
                });

                notifySpeakingModel(`Oops! Something went wrong while creating the media: ${error?.message || "Unknown error"}. But don't worry, let me continue explaining!`);

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

      // Send responses back to the FUNCTION model
      functionClient.sendToolResponse({
        functionResponses,
      });
    };

    functionClient.on("toolcall", onToolCall);
    return () => {
      functionClient.off("toolcall", onToolCall);
    };
  }, [functionClient, lastGeneratedVideo, lastGeneratedImage, notifySpeakingModel]);

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
      
      {/* Media Generation Status Indicator */}
      {isGeneratingMedia && (
        <div className="media-generating-indicator">
          <div className="generating-spinner" />
          <span>Creating {generatingMediaType === "video" ? "cartoon" : "picture"}...</span>
        </div>
      )}
      
      {/* Media Loading Indicator */}
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
