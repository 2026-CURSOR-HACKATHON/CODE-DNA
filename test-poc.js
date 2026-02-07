const { CursorDB } = require('./out/cursor/cursorDB');

console.log('========================================');
console.log('POC Day 1-2: Cursor DB 접근 검증');
console.log('========================================\n');

async function runPOC() {
  try {
    const cursorDB = new CursorDB();
    
    console.log('Step 1: DB 초기화 중...');
    await cursorDB.initialize();
    console.log(`✅ DB Path: ${cursorDB.getDbPath()}\n`);

    console.log('Step 2: Composer 읽기 중...');
    const composers = await cursorDB.getAllComposers();
    console.log(`✅ 총 ${composers.length}개의 Composer 발견\n`);

    if (composers.length > 0) {
      console.log('Step 3: 최근 5개 Composer 샘플:');
      const recentComposers = composers.slice(-5);
      recentComposers.forEach((c, i) => {
        const date = new Date(c.createdAt).toISOString().substring(0, 19);
        console.log(`  ${i + 1}. ID: ${c.composerId.substring(0, 8)}... | Created: ${date}`);
      });
      console.log();

      const latestComposer = composers[composers.length - 1];
      console.log('Step 4: 최신 Composer의 Bubble 읽기 중...');
      console.log(`  Composer ID: ${latestComposer.composerId}`);
      
      const bubbles = await cursorDB.getBubblesForComposer(latestComposer.composerId);
      console.log(`✅ 총 ${bubbles.length}개의 Bubble 발견\n`);

      if (bubbles.length > 0) {
        console.log('Step 5: Bubble 샘플 데이터:');
        
        const userBubbles = bubbles.filter(b => b.type === 'user');
        const aiBubbles = bubbles.filter(b => b.type === 'assistant');
        
        console.log(`  - User Bubbles: ${userBubbles.length}개`);
        console.log(`  - AI Bubbles: ${aiBubbles.length}개\n`);

        if (userBubbles.length > 0) {
          const firstUser = userBubbles[0];
          console.log('  📝 첫 번째 User Bubble:');
          console.log(`     Type: ${firstUser.type}`);
          console.log(`     Bubble ID: ${firstUser.bubbleId}`);
          console.log(`     Text (처음 150자): ${firstUser.text.substring(0, 150)}...`);
          console.log(`     Created: ${new Date(firstUser.createdAt).toISOString()}\n`);
        }

        if (aiBubbles.length > 0) {
          const firstAI = aiBubbles[0];
          console.log('  🤖 첫 번째 AI Bubble:');
          console.log(`     Type: ${firstAI.type}`);
          console.log(`     Bubble ID: ${firstAI.bubbleId}`);
          console.log(`     Text (처음 150자): ${firstAI.text.substring(0, 150)}...`);
          console.log(`     Created: ${new Date(firstAI.createdAt).toISOString()}\n`);
        }
      }

      console.log('Step 6: 가장 최근 AI 응답 찾기...');
      const latestAI = await cursorDB.getLatestAIBubble();
      if (latestAI) {
        console.log('✅ 가장 최근 AI 응답 발견:');
        console.log(`  Composer ID: ${latestAI.composerId}`);
        console.log(`  Bubble ID: ${latestAI.bubbleId}`);
        console.log(`  Created: ${new Date(latestAI.createdAt).toISOString()}`);
        console.log(`  Text (처음 200자):\n  ${latestAI.text.substring(0, 200)}...\n`);
      } else {
        console.log('ℹ️ AI 응답을 찾을 수 없습니다.\n');
      }
    }

    cursorDB.close();

    console.log('========================================');
    console.log('✅ POC Day 1-2 완료');
    console.log('========================================');
    console.log('검증 결과:');
    console.log('  ✅ sql.js로 state.vscdb 읽기 성공');
    console.log('  ✅ Composer 데이터 파싱 성공');
    console.log('  ✅ Bubble 데이터 파싱 성공');
    console.log('  ✅ 실제 데이터 구조 확인 완료');
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ 오류 발생:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runPOC();
