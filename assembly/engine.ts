/*
 * Chess App using React and Web Workers
 * Copyright (C) 2019 mhonert (https://github.com/mhonert)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { BLACK, Board, BOARD_BORDER, EMPTY, WHITE } from './board';
import {
  decodeEndIndex,
  decodePiece, decodeStartIndex,
  generateMoves,
  isCheckMate, performMove, undoMove
} from './move-generation';
import { KING, PAWN, ROOK } from './pieces';
import { sign } from './util';


// Evaluate board position with the given move performed
function evaluateMoveScore(board: Board, encodedMove: i32): i32 {
  const previousState = board.getState();

  const targetPieceId = decodePiece(encodedMove);
  const moveStart = decodeStartIndex(encodedMove);
  const moveEnd = decodeEndIndex(encodedMove);
  const previousPiece = board.items[moveStart];

  const removedPiece = performMove(board, targetPieceId, moveStart, moveEnd);

  const score = evaluatePosition(board);

  undoMove(board, previousPiece, moveStart, moveEnd, removedPiece, previousState);

  return score;
};


function sortMovesByScore(board: Board, moves: Array<i32>, playerColor: i32): Array<i32> {

  for (let i: i32 = 0; i < moves.length; i++) {
    const score: i32 = evaluateMoveScore(board, moves[i]);
    moves[i] = encodeScoredMove(moves[i], score);
  }

  if (playerColor == WHITE) {
    moves.sort(whiteScoringComparator);
  } else {
    moves.sort(blackScoringComparator);
  }

  return moves;
};

function whiteScoringComparator(a: i32, b: i32): i32 {
  const scoreA = decodeScore(a);
  const scoreB = decodeScore(b);

  if (scoreA == scoreB) {
    return 0;
  } else if (scoreA > scoreB) {
    return -1;
  } else {
    return 1;
  }
}

function blackScoringComparator(a: i32, b: i32): i32 {
  const scoreA = decodeScore(a);
  const scoreB = decodeScore(b);

  if (scoreA == scoreB) {
    return 0;
  } else if (scoreA < scoreB) {
    return -1;
  } else {
    return 1;
  }
}


/** Finds the best move for the current player color.
 *
 * @param board
 * @param playerColor BLACK (-1) or WHITE (1)
 * @param remainingHalfMoves Half moves to search for
 */
export function findBestMove(board: Board, playerColor: i32, remainingHalfMoves: i32): i32 {
  let alpha: i32 = I32.MIN_VALUE;
  let beta: i32 = I32.MAX_VALUE;

  const result = recFindBestMove(
    board,
    alpha,
    beta,
    playerColor,
    remainingHalfMoves,
    0
  );

  return decodeMove(result);
};

// If a check mate position can be achieved, then earlier check mates should have a better score than later check mates
// to prevent unnecessary delays.
function adjustScore(board: Board, realDepth: i32): i32 {
  const score = evaluatePosition(board);

  if (score == BLACK_MATE_SCORE) {
    return score + (100 - realDepth);
  } else if (score == WHITE_MATE_SCORE) {
    return score - (100 - realDepth);
  }

  return score;
};

const MIN_SCORE = -16382;
const MAX_SCORE = 16382;

// Recursively calls itself with alternating player colors to
// find the best possible move in response to the current board position.
//
function recFindBestMove(board: Board, alpha: i32, beta: i32, playerColor: i32, remainingLevels: i32, depth: i32): i32 {
  if (remainingLevels <= 0) {
    return encodeScoredMove(0, adjustScore(board, depth) * playerColor);
  }

  const moves = sortMovesByScore(board, generateMoves(board, playerColor), playerColor);

  if (moves.length == 0) {
    // no more moves possible (i.e. check mate or stale mate)
    return encodeScoredMove(0, adjustScore(board, depth) * playerColor);
  }

  let bestScore: i32 = MIN_SCORE;
  let bestMove: i32 = 0;

  for (let i: i32 = 0; i < moves.length; i++) {
    const scoredMove = moves[i];
    const move = decodeMove(scoredMove);
    const previousState = board.getState();

    const targetPieceId = decodePiece(move);
    const moveStart = decodeStartIndex(move);
    const moveEnd = decodeEndIndex(move);
    const previousPiece = board.items[moveStart];

    const removedPiece = performMove(board, targetPieceId, moveStart, moveEnd);

    const result = recFindBestMove(
      board,
      -beta,
      -alpha,
      -playerColor,
      remainingLevels - 1,
      depth + 1,
    );

    undoMove(board, previousPiece, moveStart, moveEnd, removedPiece, previousState);

    let unadjustedScore: i32 = decodeScore(result);

    const score = -unadjustedScore;

    // Use mini-max algorithm ...
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }

    // ... with alpha-beta-pruning to eliminate unnecessary branches of the search tree:
    alpha = max(alpha, bestScore);
    if (alpha >= beta) {
      break;
    }
  }


  return encodeScoredMove(bestMove, bestScore);
};


const PIECE_VALUES: Array<i32> = [1, 3, 3, 5, 9]; // Pawn, Knight, Bishop, Rook, Queen

export const WHITE_MATE_SCORE: i32 = -16000;
export const BLACK_MATE_SCORE: i32 = 16000;


/** Evaluates the current position and generates a score.
 *  Scores below 0 are better for the black and above 0 better for the white player.
 *
 * @param board
 * @returns {number} Position score
 */
export function evaluatePosition(board: Board): i32 {
  // Check mate is the best possible score for the other player
  if (isCheckMate(board, BLACK)) {
    return BLACK_MATE_SCORE;
  } else if (isCheckMate(board, WHITE)) {
    return WHITE_MATE_SCORE;
  }

  let materialValue = 0;
  let positionValue = 0;
  let whiteBishops = 0;
  let blackBishops = 0;
  let whiteKnights = 0;
  let blackKnights = 0;

  let whitePawnRows = 0;
  let blackPawnRows = 0;
  for (let i = 21; i <= 98; i++) {
    const piece = board.items[i];
    const pieceId = abs(piece);

    if (piece == EMPTY || piece == BOARD_BORDER || pieceId == KING) {
      continue;
    }

    // Sum of all piece values (material) on the board
    const pieceValue = PIECE_VALUES[pieceId - 1];
    materialValue += pieceValue * sign(piece);

    if (piece == -1) {
      const rowBitPattern = 1 << boardRowFromIndex(i);
      if ((blackPawnRows & rowBitPattern) != 0) {
        positionValue += 5; // worse score for double pawns
      } else {
        blackPawnRows |= rowBitPattern;
      }
    } else if (piece == 1) {
      const rowBitPattern = 1 << boardRowFromIndex(i);
      if ((whitePawnRows & rowBitPattern) != 0) {
        positionValue -= 5; // worse score for double pawns
      } else {
        whitePawnRows |= rowBitPattern;
      }
    } else if (piece == -2) {
      blackKnights++;
    } else if (piece == 2) {
      whiteKnights++;
    } else if (piece == -3) {
      blackBishops++;
    } else if (piece == 3) {
      whiteBishops++;
    }

    // Bonus point for pieces outside the starting positions
    if (i >= 41 && i <= 88) {
      if (board.items[i] < -1 && board.items[i] > -4) {
        positionValue -= 2;
      } else if (board.items[i] > 1 && board.items[i] < 4) {
        positionValue += 2;
      }
    }
  }

  // Bonus points if knights exist as pair
  if (whiteKnights == 2) {
    positionValue += 4;
  }

  if (blackKnights == 2) {
    positionValue -= 4;
  }

  // Bonus points if bishops exist as pair
  if (whiteBishops == 2) {
    positionValue += 6;
  }

  if (blackBishops == 2) {
    positionValue -= 6;
  }

  // Bonus points, if pawns occupy the center positions
  if (board.items[54] == -1) {
    positionValue -= 2;
  }

  if (board.items[55] == -1) {
    positionValue -= 2;
  }

  if (board.items[64] == 1) {
    positionValue += 2;
  }

  if (board.items[65] == 1) {
    positionValue += 2;
  }

  // Bonus points if pieces involved in castling have not yet moved
  let castleValue = 0;

  if (board.whiteKingMoved()) {
    castleValue--;
  }

  if (board.whiteRightRookMoved()) {
    castleValue--;
  }

  if (board.whiteLeftRookMoved()) {
    castleValue--;
  }

  if (board.blackKingMoved()) {
    castleValue++;
  }

  if (board.blackRightRookMoved()) {
    castleValue++;
  }

  if (board.blackLeftRookMoved()) {
    castleValue++;
  }

  // Bonus points for safe castle positions
  if (board.items[27] == -KING && board.items[26] == -ROOK &&
      board.items[36] == -PAWN && board.items[37] == -PAWN && board.items[38] == -PAWN) {

    castleValue -= 10;

  } else if (board.items[22] == -KING && board.items[23] == -ROOK &&
             board.items[31] == -PAWN && board.items[32] == -PAWN && board.items[33] == -PAWN) {

    castleValue -= 10;
  }

  if (board.items[97] == KING && board.items[96] == ROOK &&
      board.items[86] == PAWN && board.items[87] == PAWN && board.items[88] == PAWN) {

    castleValue += 10;

  } else if (board.items[92] == KING && board.items[93] == ROOK &&
             board.items[81] == PAWN && board.items[82] == PAWN && board.items[83] == PAWN) {

    castleValue += 10;
  }

  for (let i = 31; i <= 33; i++) {
    if (board.items[i] != -1) {
      castleValue++;
    }
  }

  for (let i = 36; i <= 38; i++) {
    if (board.items[i] != -1) {
      castleValue++;
    }
  }

  for (let i = 81; i <= 83; i++) {
    if (board.items[i] != 1) {
      castleValue--;
    }
  }

  for (let i = 86; i <= 88; i++) {
    if (board.items[i] != 1) {
      castleValue--;
    }
  }

  return materialValue * 100 + positionValue + castleValue;
};


export const boardRowFromIndex = (index: i32): i32 => (index - 21) % 10;

export function encodeScoredMove(move: i32, score: i32): i32 {
  if (score < 0) {
    return move | 0x80000000 | (-score << 17);

  } else {
    return move | (score << 17);
  }
}

export function decodeScore(scoredMove: i32): i32 {
  return (scoredMove & 0x80000000) != 0
    ? -((scoredMove & 0x7FFE0000) >>> 17)
    : scoredMove >>> 17;
}

export function decodeMove(scoredMove: i32): i32 {
  return scoredMove & 0x1FFFF;
}
