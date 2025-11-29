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

import { createContext, FC, ReactNode, useContext } from "react";
import { useFunctionAPI, UseFunctionAPIResults } from "../hooks/use-function-api";
import { LiveClientOptions } from "../types";

const FunctionAPIContext = createContext<UseFunctionAPIResults | undefined>(undefined);

export type FunctionAPIProviderProps = {
  children: ReactNode;
  options: LiveClientOptions;
};

export const FunctionAPIProvider: FC<FunctionAPIProviderProps> = ({
  options,
  children,
}) => {
  const functionAPI = useFunctionAPI(options);

  return (
    <FunctionAPIContext.Provider value={functionAPI}>
      {children}
    </FunctionAPIContext.Provider>
  );
};

export const useFunctionAPIContext = () => {
  const context = useContext(FunctionAPIContext);
  if (!context) {
    throw new Error("useFunctionAPIContext must be used within a FunctionAPIProvider");
  }
  return context;
};

