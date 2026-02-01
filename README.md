<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Noto+Sans+KR&size=32&pause=1200&color=111111&center=true&vCenter=true&width=1000&lines=Menjupmon+Backend;Auth+%2F+Session+%2F+AI+Feedback+API" alt="Menjupmon Backend Typing" />
</p>

<p align="center">
  <a href="https://github.com/alstlr0307/interviewmon-front"><img src="https://img.shields.io/badge/Frontend-Repo-181717?style=for-the-badge&logo=github&logoColor=white" /></a>
</p>

<br/>

## 📚 목차
1. [백엔드 역할](#1-백엔드-역할)  
2. [기술 스택](#2-기술-스택)  
3. [프로젝트 구조](#3-프로젝트-구조)  
4. [주요 기능/API](#4-주요-기능api)  
5. [환경 변수](#5-환경-변수)  
6. [실행 방법](#6-실행-방법)  

<br/>

## <a id="1-백엔드-역할"></a> 1. 백엔드 역할
- 회원가입/로그인 및 JWT 기반 인증
- 인터뷰 세션 생성/저장/조회
- 질문 풀 제공 및 시드 데이터 관리
- 답변 기록 저장 + AI 피드백 생성(OpenAI)
- MySQL 연동

<br/>

## <a id="2-기술-스택"></a> 2. 기술 스택
- Node.js
- Express
- mysql2
- jsonwebtoken (JWT)
- bcryptjs
- zod
- helmet, express-rate-limit
- morgan
- OpenAI SDK

<br/>

<pre>
Menjupmon-back
└─ interviewmon-api
   ├─ index.js              # API 서버(라우팅/미들웨어/핵심 기능)
   ├─ db.js                 # MySQL pool
   ├─ token.js              # 토큰 발급/검증 관련 로직
   ├─ questions.js          # 질문 관련 라우트/로직
   ├─ interview.js          # 인터뷰 세션 관련 라우트/로직
   ├─ sessionAnswers.js     # 답변 저장/조회
   ├─ ai.js                 # OpenAI 기반 피드백 모듈(JSON 응답)
   ├─ seed-questions.js     # 질문 시드 스크립트
   └─ package.json
</pre>

<br/>

## <a id="4-주요-기능api"></a> 4. 주요 기능/API
프로젝트 코드 기준으로 아래 영역이 핵심입니다.
- Auth: 회원가입/로그인/내 정보
- Sessions: 세션 생성/조회/저장
- Questions: 질문 조회/시드
- AI Feedback: 답변 평가/피드백 생성

(실제 엔드포인트는 `index.js`, `questions.js`, `interview.js`를 기준으로 확인하세요.)

<br/>

## <a id="5-환경-변수"></a> 5. 환경 변수
`.env` 예시

<pre>
PORT=8080
CORS_ORIGIN=http://localhost:3000

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=****
MYSQL_DATABASE=menjupmon

JWT_ACCESS_SECRET=****
JWT_REFRESH_SECRET=****

OPENAI_API_KEY=****
OPENAI_MODEL=gpt-4.1-mini
</pre>

<br/>

## <a id="6-실행-방법"></a> 6. 실행 방법
<pre>
git clone https://github.com/alstlr0307/interviewmon-api.git
cd interviewmon-api
npm install

# 실행
node index.js
</pre>

<br/>

### 참고
- `package.json`의 스크립트 경로가 `api/index.js`로 되어 있다면, 현재 구조에 맞게 `index.js`로 맞춰주면 됩니다.
- 질문 시드는 아래로 실행합니다.
<pre>
npm run seed:questions
</pre>
