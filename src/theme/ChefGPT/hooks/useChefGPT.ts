import { useCallback, useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import track from "../track";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import type { CookbookDocsBotConfig } from "../types";

/**
 *
 * @param props -
 *  We could either pass in the contract name to be included in the default message
 *  or the initial message as a whole
 * @example
 * useChefGPT({ contractName: "UniswapV2Router02" }); // "Hey, I'm Richard. I can help answer any question about UniswapV2Router02 you might have. Ask away!"
 * useChefGPT({ initialMessage: "What is the address of UniswapV2Router02?" }); // "What is the address of UniswapV2Router02?"
 */
export const useChefGPT = (config: CookbookDocsBotConfig) => {
  const { siteMetadata } = useDocusaurusContext();
  const {
    greetingMessage: initialMessage,
    apiBaseUrl,
    preTextPrompt,
    dataSources,
    extraTrackingData,
  } = config;

  const setDefaultMessages = (): [Message] => [
    {
      uuid: uuidv4(),
      role: "assistant",
      content: initialMessage,
      typing: false,
    },
  ];
  const [messages, setMessages] = useState<Message[]>(setDefaultMessages);

  const setDefaultPendingMessage = () =>
    ({
      role: "assistant",
      typing: false,
      content: "",
      uuid: uuidv4(),
    }) as const;

  const [pendingMessage, setPendingMessage] = useState<Message>(
    setDefaultPendingMessage,
  );

  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [currentThreadUUID, setCurrentThreadUUID] = useState<string | null>(
    null,
  );
  // Once the pending message is typed out, add it to the messages array and reset the pending message to default
  useEffect(() => {
    if (!pendingMessage.typing && pendingMessage.content.length > 0) {
      addMessage(pendingMessage);
      setPendingMessage(setDefaultPendingMessage);
    }
  }, [pendingMessage.typing]);

  const createNewThread = async (): Promise<Thread> => {
    return await fetch(`${apiBaseUrl}/chefgpt/thread/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        type: "docsbot",
      }),
    })
      .then((res) => res.json())
      .then((data) => data.thread);
  };

  const getOrCreateThread = async (): Promise<Thread> => {
    if (!currentThreadId) {
      const thread = await createNewThread();
      setCurrentThreadId(thread._id);
      if (thread.uuid) setCurrentThreadUUID(thread.uuid); // uuid is added to threads created by anonymous users
      return thread;
    } else {
      // If thread already exists, we will just construct thread object from state
      return {
        _id: currentThreadId,
        ...(currentThreadUUID && { uuid: currentThreadUUID }), // uuid is added to threads created by anonymous users
      };
    }
  };

  const finishedTyping = useCallback(() => {
    // Set typing to false which will trigger the useEffect above
    // to add the pending message to the messages array
    setPendingMessage((prevMessage) => ({ ...prevMessage, typing: false }));
  }, []);

  /**
   *
   * @param _message - Message to be added to messages array
   * @returns uuid of message
   */
  const addMessage = (_message: Omit<Message, "uuid">) => {
    const message = { ..._message, uuid: uuidv4() }; // Add uuid to message
    setMessages((prevMessages) => [message, ...prevMessages]);
    return message.uuid;
  };

  const askQuestion: AskQuestionFn = async (question) => {
    if (pendingMessage.typing) {
      alert(
        // TODO: convert to toast
        "Please wait for Chef GPT to finish typing before asking another question.",
      );
      return;
    }
    if (!apiBaseUrl) throw new Error("apiBaseUrl is not defined");
    track(apiBaseUrl, "ChefGPT Used", {
      ...extraTrackingData,
      // We put extraTrackingData first, so it won't override the default values
      query: question,
      type: "docs",
      siteMetadata,
    });

    setPendingMessage((prev) => ({
      ...prev,
      typing: true,
    }));

    // Add user message to messages array
    const messageUUID = addMessage({
      role: "user" as const,
      content: question,
      typing: false,
    });

    try {
      const payload = {
        preTextPrompt,
        dataSources: dataSources.map(({ name, hostname }) => ({
          name,
          hostname: `${hostname}/sitemap.xml`,
        })),
      };
      const thread = await getOrCreateThread();

      const body = JSON.stringify({
        type: "docsbot",
        question,
        data: payload,
        threadId: thread._id,
        ...(thread.uuid && { threadUUID: thread.uuid }), // uuid is added to threads created by anonymous users
      });

      const response = await fetch(`${apiBaseUrl}/chefgpt/new-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        priority: "high",
        credentials: "include",
        body,
      });
      console.log("response", response);
      if (!response.ok) {
        throw new Error(response.statusText);
      }

      /* Processing stream start */
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        const newValue = decoder.decode(value).split("\n\n").filter(Boolean);

        newValue.forEach((newVal) => {
          const serverMessage = JSON.parse(newVal.replace("data: ", ""));
          setPendingMessage(({ content: prevContent, ...prevMessage }) => ({
            ...prevMessage,
            content: prevContent + serverMessage, // Concatenate new message content received from server to previous message content
            typing: true,
          }));
        });
      }
      /* Processing stream end */
    } catch (err) {
      console.error("Error while asking question", err);
      alert("Something went wrong while asking question. Please try again.");
      // Because we optimistaclly added the message to the messages array before, we need to remove it if the request fails
      setMessages((prevMessages) =>
        prevMessages.filter((message) => message.uuid !== messageUUID),
      );
    } finally {
      // stream ended
      finishedTyping();
    }
  };

  const clearMessages = () => {
    setMessages(setDefaultMessages);
    setPendingMessage(setDefaultPendingMessage);
  };

  return [
    messages,
    pendingMessage,
    askQuestion,
    {
      clearMessages,
      setCurrentThreadId,
    },
  ] as const;
};

export type Message = {
  uuid: string; // Unique identifier for each message, to be used in the key prop
  role: "user" | "assistant";
  content: string;
  typing: boolean;
};
export type Thread = {
  _id: string;
  uuid: string;
};
export type AskQuestionFn = (question: string) => Promise<void>;