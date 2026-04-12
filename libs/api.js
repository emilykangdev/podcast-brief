import axios from "axios";
import { toast } from "react-hot-toast";
import { redirect } from "next/navigation";
import config from "@/config";

// use this to interact with our own API (/app/api folder) from the front-end side
// See https://shipfa.st/docs/tutorials/api-call
const apiClient = axios.create({
  baseURL: "/api",
});

apiClient.interceptors.response.use(
  function (response) {
    return response.data;
  },
  function (error) {
    let message = "";

    if (error.response?.status === 401) {
      toast.error("Please login");
      redirect(config.auth.loginUrl);
    } else if (error.response?.status === 402) {
      // Insufficient credits — the form handles this with a rich modal.
      // Attach structured data and reject without toasting.
      error.creditData = error.response.data;
      return Promise.reject(error);
    } else if (error.response?.status === 429) {
      toast.error("Slow down — please try again in a moment.");
      return Promise.reject(error);
    } else if (error.response?.status === 403) {
      message = error?.response?.data?.error || "Access denied";
    } else {
      message = error?.response?.data?.message || error?.response?.data?.error || error.message || error.toString();
    }

    error.message = typeof message === "string" ? message : JSON.stringify(message);

    console.error(error.message);

    // Automatically display errors to the user
    if (error.message) {
      toast.error(error.message);
    } else {
      toast.error("something went wrong...");
    }
    return Promise.reject(error);
  }
);

export default apiClient;
