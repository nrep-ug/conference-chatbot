import { getEmbedding, askMistral } from "@/lib/ollama";
import { qdrant, QDRANT_COLLECTION } from "@/lib/qdrant";

export async function POST(request) {
  try {
    const { question } = await request.json();

    if (!question || question.trim().length < 2) {
      return Response.json(
        { error: "Please provide a valid question." },
        { status: 400 }
      );
    }

    const queryVector = await getEmbedding(`search_query: ${question}`);

    const searchResults = await qdrant.search(QDRANT_COLLECTION, {
      vector: queryVector,
      limit: 5,
      with_payload: true,
    });

    const context = searchResults
      .map((result, index) => {
        return `Source ${index + 1}: ${result.payload.source}\n${result.payload.text}`;
      })
      .join("\n\n");

    const answer = await askMistral({
      question,
      context,
    });

    return Response.json({
      answer,
      sources: searchResults.map((result) => ({
        source: result.payload.source,
        score: result.score,
      })),
    });
  } catch (error) {
    console.error(error);

    return Response.json(
      { error: "The chatbot failed to process the question." },
      { status: 500 }
    );
  }
}